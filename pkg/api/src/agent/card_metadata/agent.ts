import { APICallError, generateObject, NoObjectGeneratedError } from "ai";
import { RateLimitError, ScorecardReadError } from "../../extraction_errors";
import {
  imageProviderOptionsFor,
  maxOutputTokensFor,
  type ModelResolver,
  type ModelSpec,
  providerOptionsFor,
} from "../../model";
import { CardMetadata } from "./schema";

const METADATA_PROMPT = `You are extracting a golf course's printed LAYOUT from a photo of a scorecard. This is NOT about the handwritten scores — ignore any pencil marks. You are reading the pre-printed rating table: the nine names, the tee positions, and each tee's per-hole par, yardage, and stroke index.

A scorecard usually prints one, two, or three "nines" (named nine-hole loops). Each nine has its own name — often printed as a header or watermarked across the card (e.g. "White Oak", "Blue Spruce", "Red Maple"). Use that as the nine's name. Do NOT confuse a nine name with the course's own name, with hole names (some courses print a unique name above every hole column), or with section labels ("Initials", "Handicap", "Scorer").

A NINE IS NINE HOLES. This is the single most important rule: every nine you emit MUST contain at most nine holes per tee. Most cards lay out a full 18 as one continuous grid — holes 1–9 subtotalled "OUT", holes 10–18 subtotalled "IN", and a combined "TOT" column. That is TWO nines, not one, and you MUST split it: holes 1–9 become one nine and holes 10–18 become another, each tee's row cut at the same place. Never emit a single nine spanning holes 1–18. If the two halves have no printed names of their own, you MUST still name them — exactly "Front" for holes 1–9 and exactly "Back" for holes 10–18. Do not leave a nine's name null just because the card doesn't print one. Ignore the OUT / IN / TOT columns themselves — they are subtotals, not holes.

Within each nine, the card prints a grid: one ROW per tee position (labeled at the left, e.g. "Blue", "White", "Gold", "Red", "Green", and sometimes combination tees like "Blue/White" or "Red/Green"), and one COLUMN per hole. Each cell is that tee's yardage for that hole. Capture EVERY distinct tee position as a separate tee, with its exact printed name.

Some cards print a COMBINATION tee as a thin marker strip between two full yardage rows rather than as a row of its own — often labeled just "COMBO" with a rating, and marked hole-by-hole with a colored arrow/triangle pointing at whichever of the two neighbouring tees that hole is played from. Do not skip these — a combination strip is a real, playable, separately-rated tee. Emit it as a tee named for the two tees it interleaves, longer first and slash-joined: exactly "Blue/White" or "White/Red", never "Blue/White Combo", "Combo", or "Combo (Blue/White)". Take each hole's yardage from the neighbouring row the marker for that hole points at, and check your work against the strip's printed OUT/IN subtotal — it will not equal either neighbour's, and if your holes don't add up to it you've read a marker backwards.

Many cards print the men's and women's ratings as two separate blocks stacked on the page, repeating the SAME tee positions with the same yardages but different ratings and sometimes a different par. These are not extra tees: emit each tee position ONCE per nine.

For each tee, list its holes in printed order. For each hole record: its printed hole number, its par, its yardage from that tee, and its stroke index. Par is printed in a "Par" row that is usually shared by all tees — repeat it onto every tee's holes. Occasionally a hole's par differs by tee, printed as a split like "4/5". In that case rank the tees by THAT HOLE's yardage and give the LONGEST-yardage tees the HIGHER par and the shortest/most-forward tees the lower par — a hole doesn't get easier from further back. (This is about tee LENGTH, not about which nine the hole is on; it has nothing to do with the "Front"/"Back" nine names above.) Use null for a yardage that isn't printed or isn't legible; par should always be a single number.

The STROKE INDEX is the row labeled "Handicap", "Hcp", "HDCP", "Index", or "Stroke": a RANKING of the holes by difficulty that decides the order in which a player receives handicap strokes (1 = hardest). Across a full 18 the values are 1–18 with no repeats, so a single nine carries nine of them — very often all-odd on one nine and all-even on the other. Do not confuse this row with par, with a yardage, or with the hole number; a mid-single-digit value in a "Handicap" row is an index, not a par. Like par it is shared by every tee, so repeat the same value onto each tee's holes for that nine. Some cards print a separate women's handicap row — when both are printed, use the men's. If the card doesn't print the row, or you can't read it, use null for every hole rather than guessing a ranking from the pars.

Do not invent tees, holes, or nines that aren't printed. Only include the "9 Tot" / "18 Tot" columns' data as nothing — those are totals, not holes.

When a text value is unknown, use null — never an empty string. Respond with JSON matching the provided schema exactly.`;

// Modeled on card_scores: gemini-3.5-flash reads scorecard grids cheaply and
// accurately. Layout tables are larger than a single played round (many tees ×
// many holes), so the output-token ceiling is higher.
const DEFAULT_MODEL: ModelSpec = "google/gemini-3.5-flash@low";

export async function extractCardMetadata({
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
      schema: CardMetadata,
      maxOutputTokens: maxOutputTokensFor(model, 16384),
      providerOptions: providerOptionsFor(model),
      system: METADATA_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the course layout from this scorecard image." },
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
    return object;
  } catch (error) {
    if (error instanceof ScorecardReadError) throw error;
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      throw new RateLimitError("Vision model rate limited");
    }
    // The schema's 12-hole ceiling on a nine is a hard guardrail: a model that
    // reads an 18-hole card as one nine fails validation here rather than
    // writing a bogus nine to the database. Surface it as a read error so the
    // admin sees "re-shoot / retry" rather than a raw SDK failure.
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new ScorecardReadError(
        "Couldn't read a valid course layout off this card — the extraction didn't split " +
          "into nine-hole sets. Try again, or re-shoot the card.",
      );
    }
    throw error;
  }
}
