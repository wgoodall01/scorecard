import { z } from "zod";

// What the card_metadata agent reads off a scorecard photo: the printed course
// LAYOUT (nine names, tee positions, and per-tee per-hole par + yardage), as
// opposed to card_scores which reads the handwritten play. This feeds the
// research_course agent, which reconciles it against the USGA NCRDB mirror into
// a CourseProposal.
//
// Same structured-output discipline as card_scores/schema.ts: every field is
// required, absence is null (never a missing key), and the per-hole/per-tee
// dimension rides in array items rather than parameters — so the whole schema
// has only a handful of nullable (union-typed) parameters and zero optionals,
// the one shape all three providers' compilers accept.

export const MetadataHole = z.object({
  number: z.number().int().min(1).max(18).describe("The printed hole number."),
  par: z
    .number()
    .int()
    .describe(
      "This hole's par FROM THIS TEE. Par is usually the same across tees; when the card " +
        'prints a split like "4/5" it differs by tee — give the longer/back tees the higher ' +
        "value and the forward tees the lower one.",
    ),
  yardage: z
    .number()
    .int()
    .nullable()
    .describe("This hole's printed yardage from this tee, or null if not printed/legible."),
});
export type MetadataHoleSchema = z.infer<typeof MetadataHole>;

export const MetadataTee = z.object({
  name: z
    .string()
    .nullable()
    .describe(
      'The tee position\'s printed name exactly as on the card ("Blue", "White/Gold", …), ' +
        "or null if the row is unlabeled. A combination tee is named for the two tees it " +
        'interleaves, longer first and slash-joined — "Blue/White", never "Blue/White Combo" ' +
        'or "Combo (Blue/White)".',
    ),
  holes: z
    .array(MetadataHole)
    // Hard guardrail against the failure this schema exists to prevent: reading
    // an 18-hole card as ONE nine. A "nine" is nine holes; the ceiling is 12
    // rather than 9 only to leave room for cards that print extra tiebreaker /
    // playoff holes on the same loop. Anything longer is an unsplit 18 and must
    // fail validation rather than land in the database as a bogus nine.
    .max(12)
    .describe(
      "One entry per printed hole on this nine, in order. A nine has NINE holes (at most 12, " +
        "and only when the card prints extra tiebreaker holes) — never 18.",
    ),
});
export type MetadataTeeSchema = z.infer<typeof MetadataTee>;

export const MetadataNine = z.object({
  name: z
    .string()
    .nullable()
    .describe(
      'This nine\'s own printed or watermarked name ("White Oak", "Blue Spruce", …). When a ' +
        'card prints an unnamed 18 split into OUT/IN, use exactly "Front" for holes 1-9 and ' +
        '"Back" for holes 10-18. Only null if the nine is genuinely unnamed and unplaceable.',
    ),
  tees: z
    .array(MetadataTee)
    .describe("Every tee position printed for this nine (each yardage row on the card)."),
});
export type MetadataNineSchema = z.infer<typeof MetadataNine>;

export const CardMetadata = z.object({
  version: z.number().int().describe("Always 1."),
  error: z
    .string()
    .nullable()
    .describe(
      "If the image can't be read as a golf scorecard, explain why here and leave nines " +
        "empty. Otherwise null.",
    ),
  nines: z
    .array(MetadataNine)
    .describe("Every nine printed on the card (there may be one, two, or three)."),
});
export type CardMetadataSchema = z.infer<typeof CardMetadata>;
