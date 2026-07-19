import { z } from "zod";

// THE scorecard shape — what the model emits, what extractScorecard returns,
// what's stored in R2 as extracted.json, and what the eval fixtures assert.
// One schema, no wire/public split.
//
// Per-player data is index-aligned ARRAYS: `players` lists the players in
// score-row order, and every `scores`/`writtenTotals` array lines up with it
// (entry 0 = players[0], one entry per player; null = "player exists but
// this value isn't written/legible"). Every field is required; absence is
// expressed with null, never a missing key. This is also the only shape all
// three providers' structured-output compilers accept:
//   - Anthropic caps union-typed parameters at 16 (rules out per-player
//     nullable fields) AND caps optional parameters (rules out absent-key
//     style), and requires `additionalProperties: false` (rules out records).
//   - Google's response_schema rejects `const` (rules out z.literal).
//   - OpenAI structured output needs a fixed key set (fine here).
// Arrays carry the per-player dimension in items, not parameters: the whole
// schema has ~7 union-typed parameters and zero optionals.

const Scores = z
  .array(z.number().int().nullable())
  .describe(
    "Index-aligned with this nine's players: scores[0] is players[0]'s value, and the " +
      "array has exactly one entry per player. Use null where nothing legible is written.",
  );

export const Hole = z.object({
  hole: z.number().int().min(1).max(18),
  par: z.number().int(),
  scores: Scores,
});
export type HoleSchema = z.infer<typeof Hole>;

// A bounding box around the handwritten name/initials, on the 0–1000
// normalized scale Gemini models are trained to emit (0 = left/top edge,
// 1000 = right/bottom edge). Rescaled to 0–1 fractions right after extraction
// (see normalizeBox). Used to crop a thumbnail of the scrawl in the review UI
// so an illegible name is easy to disambiguate against a real golfer.
// Vision-model box coordinates are only approximate — a visual aid, never
// relied on for correctness.
export const PlayerBox = z.object({
  x: z.number().describe("Left edge, on a 0–1000 scale across the image width."),
  y: z.number().describe("Top edge, on a 0–1000 scale down the image height."),
  width: z.number().describe("Box width, on a 0–1000 scale across the image width."),
  height: z.number().describe("Box height, on a 0–1000 scale down the image height."),
});
export type PlayerBoxSchema = z.infer<typeof PlayerBox>;

// One player as read off a single nine. `name` is the model's single best
// reading of the handwritten name/initials; `guesses` holds up to five
// alternative readings when the scrawl is illegible or ambiguous (empty when
// it's clearly legible), which the matcher uses to recover a golfer the top
// reading alone would miss; `bbox` locates the scrawl for the review
// thumbnail.
export const Player = z.object({
  name: z.string().describe("Your single best reading of this player's name/initials as written."),
  guesses: z
    .array(z.string())
    .describe(
      "0–5 ALTERNATIVE plausible readings of the same scrawl, most likely first, when it's " +
        'illegible or ambiguous (e.g. "WG" could be ["W6", "WC"]). Do NOT repeat `name`. ' +
        "Empty when the name is clearly legible.",
    ),
  bbox: PlayerBox.nullable().describe(
    "Normalized box around this player's written name/initials, or null if it can't be located.",
  ),
});
export type PlayerSchema = z.infer<typeof Player>;

export const Nine = z.object({
  nineName: z.string().nullable(),
  players: z
    .array(Player)
    .describe(
      "The players on this nine, in score-row order (first score row first), each read " +
        "exactly as written on this nine.",
    ),
  holes: z.array(Hole),
  writtenTotals: Scores.describe(
    "The HANDWRITTEN total for this nine from the card's in/out subtotal column, " +
      "index-aligned with players — only what's actually written, never computed. " +
      "Use null where no total is written.",
  ),
});
export type NineSchema = z.infer<typeof Nine>;

export const ExtractData = z.object({
  version: z.number().int().describe("Always 1."),
  error: z
    .string()
    .nullable()
    .describe(
      "If the image can't be read as a golf scorecard, explain why here and leave the " +
        "other fields empty. Examples: \"I couldn't read the score on the fourth hole " +
        'because of glare", "this is a photo of a teapot, not a golf scorecard." ' +
        "Otherwise, null.",
    ),
  courseName: z.string().nullable(),
  date: z.string().nullable(),
  nines: z.array(Nine),
  writtenTotals: Scores.describe(
    "The HANDWRITTEN 18-hole grand total from the card's total column, index-aligned " +
      "with the players — only what's actually written, never computed. Use null " +
      "where no total is written.",
  ),
});
export type ExtractDataSchema = z.infer<typeof ExtractData>;

// What the matching agents produced for one capture. null everywhere = "no
// confident match; the review UI asks the user". Lives here (a pure zod
// module with no local imports) so the db schema can type the
// scorecard.scores_extract column without a module cycle.
export const MatchedData = z.object({
  players: z.array(z.object({ name: z.string(), userId: z.string().nullable() })),
  course: z.object({
    courseId: z.string().nullable(),
    sets: z.array(
      z.object({ nineName: z.string().nullable(), courseSetId: z.string().nullable() }),
    ),
  }),
});
export type MatchedData = z.infer<typeof MatchedData>;

// The completed scores extraction as stored in scorecard.scores_extract and
// returned by GET /scorecard/:id/scores. Also the extract_score job's return
// schema (jobs/extract_score).
export const ScoresExtractData = z.object({
  extracted: ExtractData,
  matched: MatchedData.nullable(),
});
export type ScoresExtractData = z.infer<typeof ScoresExtractData>;
