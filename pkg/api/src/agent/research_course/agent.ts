import { APICallError, generateObject } from "ai";
import { RateLimitError } from "../../extraction_errors";
import {
  maxOutputTokensFor,
  type ModelResolver,
  type ModelSpec,
  providerOptionsFor,
} from "../../model";
import { CourseProposal, type UsgaFacilityDataSchema } from "./schema";
import type { CardMetadataSchema } from "../card_metadata/schema";

const RESEARCH_PROMPT = `You are reconciling a golf course's printed scorecard layout with the USGA's official course-rating database, producing a single structured course definition.

You are given two JSON inputs:
1. "metadata" — what was read off a scorecard photo: each nine's name, and for each tee the per-hole par and yardage.
2. "usga" — the USGA NCRDB records for the facility: the facility, its rated "courses" (each USGA course is a rated NINE-COMBINATION, e.g. "WHITE/BLUE"), and each course's tees with 9-hole rating splits (front9_*/back9_*).

Produce a CourseProposal with one "set" (nine) per nine in the metadata. For each nine:

- name: the nine's printed name from the metadata (e.g. "White Oak").
- Map the nine to a USGA course + half. A USGA course named like "WHITE/BLUE" is the front nine "WHITE" plus the back nine "BLUE". Match a metadata nine to the USGA course whose name LISTS IT FIRST (by its distinguishing word/color — "White Oak" ↔ "WHITE", "Blue Spruce" ↔ "BLUE", "Red Maple" ↔ "RED"); that nine is the FRONT half of that course. Set usgaCourseId to that course's id and usgaCourseNine to "front". If instead a USGA course covers a full 18 that matches the metadata's two nines, split it: the metadata's holes-1–9 nine is usgaCourseNine "front", holes-10–18 is "back". If no USGA course matches, use null for both.
- tees: for each tee ROW in that nine's metadata, emit one ProposalTee for EACH gender the USGA rates that tee on the mapped course — usually BOTH a men's ("M") and a women's ("F") variant, so emit both (they become two separate tees sharing a name). If the USGA rates the tee for only one gender, emit just that one. For each variant:
  - name: the printed tee name (identical across its gender variants).
  - holes: copy the per-hole number, par, and yardage straight from the metadata tee (identical across the variants).
  - Match to the usga tee OF THAT GENDER on the mapped course by name (a metadata "Blue" ↔ a usga "Blue"; combination rows like "Blue/White" ↔ the usga "Blue/White") and, when the metadata yardage total helps, by length. Set usgaTeeId, gender ("M"→"m", "F"→"f"), and the 9-HOLE rating for THIS half: front9CourseRating/front9SlopeRating when usgaCourseNine is "front", back9* when "back". If no usga tee of that gender matches, use null for usgaTeeId, gender, courseRating, and slopeRating.
  - type: the app tee category. A COMBINATION tee — any tee whose name joins two names with a slash, e.g. "Blue/White" or "Red/Green" — is ALWAYS null ("Other"), never a standard category. For the remaining single-name tees, first order them from LONGEST to SHORTEST using their yardages and course ratings (more yardage / higher course rating = further back). Then assign categories outward from the regular members' tee ("standard"), filling rungs WITHOUT skipping. The ladder from longest to shortest is: tips, back, standard, senior, front, junior — and note JUNIOR is MORE FORWARD than front. Going LONGER than standard, the next tee up is "back", and only a still-longer tee beyond it is "tips": never assign "tips" unless a separate "back" tee also exists (with only two tees, the longer one is "back", not "tips"). Going SHORTER than standard, symmetrically: "senior", then "front", then "junior" — never assign "junior" without a "front", nor "front" without a "senior". Tee COLORS are a strong prior, to reconcile with the length ordering: WHITE is almost always "standard"; RED is usually the forward tee ("front"); GOLD or YELLOW is usually "senior"; BLUE and BLACK are almost always the back tees (some combination of "back"/"tips"). Examples: {Blue, White} → back, standard; {Black, Blue, White} → tips, back, standard; {Blue, White, Gold, Red, Green} → back, standard, senior, front, junior. Use null when genuinely unclear.

Top level: name = the facility name; location = a short human place if derivable (else null); ncrdbFacilityId = the facility id.

Copy pars and yardages EXACTLY from the metadata — never invent or "correct" them. Respond with JSON matching the provided schema exactly.`;

// The user's pick: everything fits in context, so one gpt-5.4-mini shot maps
// the whole facility. Text-only (no image), so no image provider options.
const DEFAULT_MODEL: ModelSpec = "openai/gpt-5.4-mini@low";

// "WHITE OAK" / "blue spruce" → "White Oak" / "Blue Spruce".
function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

export async function researchCourse({
  metadata,
  usga,
  resolver,
  model = DEFAULT_MODEL,
}: {
  metadata: CardMetadataSchema;
  usga: UsgaFacilityDataSchema;
  resolver: ModelResolver;
  model?: ModelSpec;
}) {
  try {
    const { object } = await generateObject({
      model: resolver(model),
      schema: CourseProposal,
      maxOutputTokens: maxOutputTokensFor(model, 16384),
      providerOptions: providerOptionsFor(model),
      system: RESEARCH_PROMPT,
      messages: [
        {
          role: "user",
          content: `metadata:\n${JSON.stringify(metadata)}\n\nusga:\n${JSON.stringify(usga)}`,
        },
      ],
    });
    // Nine names are printed in ALL CAPS on most cards; normalize to Title Case
    // deterministically rather than trusting the model to be consistent.
    return { ...object, sets: object.sets.map((set) => ({ ...set, name: titleCase(set.name) })) };
  } catch (error) {
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      throw new RateLimitError("Research model rate limited");
    }
    throw error;
  }
}
