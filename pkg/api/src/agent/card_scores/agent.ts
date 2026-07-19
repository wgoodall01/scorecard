import { APICallError, generateObject } from "ai";
import { getDb } from "../../../db";
import type { Env } from "../../../env";
import { RateLimitError, ScorecardReadError } from "../../extraction_errors";
import {
  imageProviderOptionsFor,
  maxOutputTokensFor,
  type ModelResolver,
  type ModelSpec,
  providerOptionsFor,
  resolveModel,
} from "../../model";
import { matchCourseSets } from "../course_match/agent";
import { courseSearchFromDb, courseSetParsFromDb } from "../course_match/search";
import { cropRegion } from "../image";
import { matchPlayers, type PlayerQuery } from "../player_match/agent";
import { playerSearchFromDb } from "../player_match/search";
import {
  ExtractData,
  type ExtractDataSchema,
  type MatchedData,
  type PlayerBoxSchema,
} from "./schema";

const EXTRACTION_PROMPT = `You are extracting structured data from a photo of a golf scorecard.

Only set courseName to text that is clearly the golf course's own name (e.g. in a logo, header, or letterhead). Scorecards have lots of other printed text that is NOT the course name — section labels like "Initials", "Scorer", or "Handicap"; hole names (some courses print or watermark a unique name for every hole); or nine names (e.g. "White Oak", "Blue Spruce"). None of these are the course name. If nothing on the card is clearly a course name, omit it rather than guessing.

Extract the date if it's handwritten on the card. Extract each nine that was actually played (front 9, back 9, or both) — omit nines with no scores. If a nine has its own printed or watermarked name (distinct from the course name), use that as nineName; otherwise describe it (e.g. "Front 9").

For each nine, list its players in the order their score rows appear on the card (first score row first). Every scores/writtenTotals array in that nine is index-aligned with this players array: entry 0 belongs to players[0], entry 1 to players[1], and so on, with exactly one entry per player.

For each player, read the handwritten name or initials as written on that nine:
- name: your single best reading.
- guesses: up to five ALTERNATIVE readings of the same scrawl, most likely first, for when the handwriting is illegible or ambiguous — e.g. an "a" that could be an "o", or initials "WG" that could read "W6". Don't repeat the name reading, and leave this empty when the writing is clearly legible.
- bbox: a tight bounding box around just that player's written name/initials, on a 0–1000 normalized scale over the whole image (x/y are the top-left corner, width/height the size; 0 is the left/top edge, 1000 is the right/bottom edge). Use null only if you truly can't locate the writing.

For each hole printed in a nine (never invent or pad in holes from the other nine), record its printed hole number, its par, and each player's handwritten score. Use null for a score that isn't written or isn't legible.

Record writtenTotals — the HANDWRITTEN totals only, never totals you compute yourself: each nine's writtenTotals comes from that nine's in/out subtotal column, and the top-level writtenTotals from the 18-hole total column. Use null wherever no total is written.

When a text value is unknown or not written, use null — never an empty string.

Respond with JSON matching the provided schema exactly.`;

// Chosen by the eval sweep (2026-07-17, 3 models × 3 efforts × 6 fixtures):
// best overall (0.977 mean) AND cheapest/fastest of the field, with
// near-zero score-cell errors. Higher effort bought nothing for this model,
// and the runner-up quality fallback is anthropic/claude-sonnet-5@medium.
const DEFAULT_MODEL: ModelSpec = "google/gemini-3.5-flash@low";

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

// The prompt asks for boxes on the 0–1000 scale Gemini models are trained to
// emit; here they're rescaled to the 0–1 fractions the crop code (matcher
// thumbnail, review thumbnail) works in. Detect the scale rather than assume
// it, so a model that ignores the instruction and returns 0–1 fractions still
// works: if every coordinate is ≤1 it's already fractional, otherwise it's
// 0–1000 (a real handwriting box always has width/height well above 1 there).
function normalizeBox(box: PlayerBoxSchema | null): PlayerBoxSchema | null {
  if (!box) return null;
  const scale = Math.max(box.x, box.y, box.width, box.height) > 1 ? 1000 : 1;
  return {
    x: clamp01(box.x / scale),
    y: clamp01(box.y / scale),
    width: clamp01(box.width / scale),
    height: clamp01(box.height / scale),
  };
}

// TODO: accept a `lookupPlayer(query) => Player[]` tool here once the player
// registry exists, so extraction can resolve written initials to real player
// identities instead of returning raw strings.
export async function extractScorecard({
  image,
  resolver,
  model = DEFAULT_MODEL,
}: {
  image: { buf: ArrayBuffer; contentType: string };
  resolver: ModelResolver;
  model?: ModelSpec;
}) {
  try {
    const { object } = await generateObject({
      model: resolver(model),
      schema: ExtractData,
      maxOutputTokens: maxOutputTokensFor(model, 4096),
      providerOptions: providerOptionsFor(model),
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the scorecard data from this image." },
            {
              type: "image",
              image: image.buf,
              mediaType: image.contentType,
              providerOptions: imageProviderOptionsFor(model),
            },
          ],
        },
      ],
    });

    if (object.error) throw new ScorecardReadError(object.error);
    // Normalize player boxes to 0–1 fractions before anything downstream crops
    // with them (the matcher's handwriting crop, the review thumbnail).
    return {
      ...object,
      nines: object.nines.map((nine) => ({
        ...nine,
        players: nine.players.map((player) => ({ ...player, bbox: normalizeBox(player.bbox) })),
      })),
    };
  } catch (error) {
    if (error instanceof ScorecardReadError) throw error;
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      throw new RateLimitError("Vision model rate limited");
    }
    throw error;
  }
}

// What the matching agents produced for one capture — stored (with the
// extraction) in scorecard.scores_extract and returned by
// GET /scorecard/:id/scores. The type lives in schema.ts (pure zod module)
// so the db schema can reference it without a module cycle.
export type { MatchedData, ScoresExtractData } from "./schema";

// Runs the player-match and course-set-match agents over an extraction,
// against the live database. Matching is best-effort: any failure (including
// rate limits — retrying the queue message would re-spend the much more
// expensive vision extraction) degrades to nulls rather than failing the
// capture, since the review UI lets the user pick manually either way.
export async function matchCapture(
  env: Env["Bindings"],
  data: ExtractDataSchema,
  image?: { buf: ArrayBuffer; contentType: string },
): Promise<MatchedData> {
  const db = getDb(env.DB);
  const resolver: ModelResolver = (spec) => resolveModel(env, spec);

  // Collapse the per-nine player rows to one query per distinct written name
  // (the dedup key), merging its alternative readings and recording where it
  // appeared ("Player 2 on Blue Spruce") to help the matcher disambiguate.
  const playerQueries = new Map<string, PlayerQuery>();
  const playerBoxes = new Map<string, PlayerBoxSchema>();
  for (const nine of data.nines) {
    const nineLabel =
      nine.nineName ?? (nine.holes.every((hole) => hole.hole >= 10) ? "Back 9" : "Front 9");
    nine.players.forEach((player, index) => {
      const entry = playerQueries.get(player.name) ?? {
        name: player.name,
        guesses: [],
        locations: [],
      };
      entry.guesses = [...new Set([...entry.guesses, ...player.guesses])];
      entry.locations = [...new Set([...entry.locations, `Player ${index + 1} on ${nineLabel}`])];
      playerQueries.set(player.name, entry);
      // Keep the first bounding box seen for this written name, to crop its
      // handwriting for the matcher.
      if (player.bbox && !playerBoxes.has(player.name)) playerBoxes.set(player.name, player.bbox);
    });
  }
  const players = [...playerQueries.values()];

  // Crop each player's handwritten name from the card so the matcher can read
  // an illegible scrawl directly. Best-effort — a failed crop just omits the
  // thumbnail, and matching degrades to the text readings.
  if (image) {
    await Promise.all(
      players.map(async (entry) => {
        const bbox = playerBoxes.get(entry.name);
        if (!bbox) return;
        const crop = await cropRegion(env, image.buf, bbox).catch(() => null);
        if (crop) entry.thumbnail = { bytes: crop.buf, mediaType: crop.contentType };
      }),
    );
  }

  const nines = data.nines.map((nine) => ({
    name: nine.nineName,
    holes: nine.holes.map((hole) => ({ number: hole.hole, par: hole.par })),
  }));

  const [matchedPlayers, course] = await Promise.all([
    matchPlayers({ players, search: playerSearchFromDb(db), resolver }).catch((error) => {
      console.error("Player matching failed", { error });
      return players.map((entry) => ({ name: entry.name, userId: null }));
    }),
    matchCourseSets({
      courseName: data.courseName,
      nines,
      search: courseSearchFromDb(db),
      listSetPars: courseSetParsFromDb(db),
      resolver,
    }).catch((error) => {
      console.error("Course matching failed", { error });
      return {
        courseId: null,
        sets: nines.map((nine) => ({ nineName: nine.name, courseSetId: null })),
      };
    }),
  ]);

  return { players: matchedPlayers, course };
}
