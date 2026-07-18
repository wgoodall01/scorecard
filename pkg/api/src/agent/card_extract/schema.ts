import { z } from "zod";

// THE scorecard shape — what the model emits, what extractScorecard returns,
// what's stored in R2 as extracted.json, and what the eval fixtures assert.
// One schema, no wire/public split.
//
// Per-player data is index-aligned ARRAYS: `players` lists the names in
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

export const Nine = z.object({
  nineName: z.string().nullable(),
  players: z
    .array(z.string())
    .describe(
      "The players on this nine, in score-row order (first score row first). Each " +
        "entry is that player's name/initials exactly as written on this nine.",
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
