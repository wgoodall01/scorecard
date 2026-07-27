import { APICallError, generateObject } from "ai";
import { RateLimitError } from "../../extraction_errors";
import {
  maxOutputTokensFor,
  type ModelResolver,
  type ModelSpec,
  providerOptionsFor,
} from "../../model";
import { CourseProposal, type UsgaFacilityDataSchema } from "./schema";
import type { CourseLayoutSchema } from "./layout";

const RESEARCH_PROMPT = `You are reconciling a golf course's LAYOUT with the USGA's official course-rating database, producing a single structured course definition.

You are given two JSON inputs:
1. "layouts" — one or more readings of the course's layout: each nine's name, and for each tee its gender (when known) and per-hole par, yardage, and stroke index. Each layout carries a "source":
   - "golfcourseapi" — a structured course database. AUTHORITATIVE for pars, yardages, stroke indexes, and tee genders: copy those verbatim and never second-guess them. Its weakness is nine NAMES — it names a nine after its tee color ("White"), not the name printed on the card ("White Oak").
   - "scorecard" — a reading of a photo of the printed card. Authoritative for nine NAMES and tee NAMES as the course actually prints them. Its pars/yardages are OCR off a photo, so where it disagrees with a "golfcourseapi" layout, the golfcourseapi values win. Its tees have no gender (a card prints one ungendered yardage row per tee).
   When you get BOTH, they describe the SAME course: produce one nine per physical nine, matching a scorecard nine to a golfcourseapi nine by its (hole, par) sequence and yardages — NOT by name, since the names are exactly what differs. Take the name from the scorecard and everything else from golfcourseapi. Do not emit a nine twice because the two layouts named it differently.
2. "usga" — the USGA NCRDB records for the facility: the facility, its rated "courses" (each USGA course is a rated NINE-COMBINATION, e.g. "WHITE/BLUE"), and each course's tees with 9-hole rating splits (front9_*/back9_*). This is the ONLY source of the 9-hole course/slope ratings, which no layout carries.

Produce a CourseProposal with one "set" (nine) per physical nine. For each nine:

- name: the nine's printed name (e.g. "White Oak"), preferring a scorecard layout's name over a golfcourseapi one.
- Map the nine to a USGA course + half. A USGA course named like "WHITE/BLUE" is the front nine "WHITE" plus the back nine "BLUE". Match a nine to the USGA course whose name LISTS IT FIRST (by its distinguishing word/color — "White Oak" ↔ "WHITE", "Blue Spruce" ↔ "BLUE", "Red Maple" ↔ "RED"); that nine is the FRONT half of that course. Set usgaCourseId to that course's id and usgaCourseNine to "front". If instead a USGA course covers a full 18 that matches the layout's two nines, split it: the holes-1–9 nine is usgaCourseNine "front", holes-10–18 is "back". If no USGA course matches, use null for both.
- tees: one ProposalTee per (tee position, gender) on that nine.
  - When the layout ALREADY gives a tee's gender (golfcourseapi does), trust it: emit exactly the gendered tees the layout lists, and do not invent a variant it didn't list.
  - When the layout has no gender (a scorecard reading), emit one ProposalTee for EACH gender the USGA rates that tee on the mapped course — usually BOTH a men's ("M") and a women's ("F") variant, so emit both (they become two separate tees sharing a name). If the USGA rates the tee for only one gender, emit just that one.
  For each tee:
  - name: the printed tee name (identical across its gender variants).
  - holes: copy the per-hole number, par, yardage, and strokeIndex straight from the layout tee. Yardages are identical across a tee's gender variants; the stroke index often is NOT (many courses print separate men's and women's rankings), so copy each variant's own.
  - Match to the usga tee OF THAT GENDER on the mapped course by name (a layout "Blue" ↔ a usga "Blue"; combination rows like "Blue/White" ↔ the usga "Blue/White") and, when the yardage total helps, by length. Set usgaTeeId, gender ("M"→"m", "F"→"f"), and the 9-HOLE rating for THIS half: front9CourseRating/front9SlopeRating when usgaCourseNine is "front", back9* when "back". If no usga tee of that gender matches, use null for usgaTeeId, courseRating, and slopeRating — but KEEP the gender the layout gave you.
  - type: the app tee category. A COMBINATION tee — any tee whose name joins two names with a slash, e.g. "Blue/White" or "Red/Green" — is ALWAYS null ("Other"), never a standard category. For the remaining single-name tees, first order them from LONGEST to SHORTEST using their yardages and course ratings (more yardage / higher course rating = further back). Then assign categories outward from the regular members' tee ("standard"), filling rungs WITHOUT skipping. The ladder from longest to shortest is: tips, back, standard, senior, front, junior — and note JUNIOR is MORE FORWARD than front. Going LONGER than standard, the next tee up is "back", and only a still-longer tee beyond it is "tips": never assign "tips" unless a separate "back" tee also exists (with only two tees, the longer one is "back", not "tips"). Going SHORTER than standard, symmetrically: "senior", then "front", then "junior" — never assign "junior" without a "front", nor "front" without a "senior". Tee COLORS are a strong prior, to reconcile with the length ordering: WHITE is almost always "standard"; RED is usually the forward tee ("front"); GOLD or YELLOW is usually "senior"; BLUE and BLACK are almost always the back tees (some combination of "back"/"tips"). Examples: {Blue, White} → back, standard; {Black, Blue, White} → tips, back, standard; {Blue, White, Gold, Red, Green} → back, standard, senior, front, junior. Use null when genuinely unclear.

Top level: name = the facility name; location = a short human place if derivable (else null); ncrdbFacilityId = the facility id.

Copy pars, yardages, and stroke indexes EXACTLY from the layout — never invent or "correct" them. Respond with JSON matching the provided schema exactly.`;

// The user's pick: everything fits in context, so one gpt-5.4-mini shot maps
// the whole facility. Text-only (no image), so no image provider options.
const DEFAULT_MODEL: ModelSpec = "openai/gpt-5.4-mini@low";

// "WHITE OAK" / "blue spruce" → "White Oak" / "Blue Spruce".
function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

export async function researchCourse({
  layouts,
  usga,
  resolver,
  model = DEFAULT_MODEL,
}: {
  // One or more readings of the course layout — a GolfCourseAPI feed, a
  // scorecard photo reading, or both when the feed had gaps. Ordered
  // authoritative-first (see src/agent/research_course/layout.ts).
  layouts: CourseLayoutSchema[];
  usga: UsgaFacilityDataSchema;
  resolver: ModelResolver;
  model?: ModelSpec;
}) {
  if (layouts.length === 0) throw new Error("researchCourse needs at least one layout");
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
          content: `layouts:\n${JSON.stringify(layouts)}\n\nusga:\n${JSON.stringify(usga)}`,
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
