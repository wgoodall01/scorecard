import { z } from "zod";
import { TEES } from "../../../schema";

// The research_course agent reconciles two inputs — a card_metadata reading and
// the USGA NCRDB mirror rows for a facility — into a CourseProposal that maps
// 1:1 onto the app's course / course_set / course_set_tee / hole tables. It's a
// one-shot generateObject call (default openai/gpt-5.4-mini): everything fits
// in context and the mapping is pure reasoning, no search.
//
// Structured-output note: this schema targets OpenAI (fixed key sets,
// additionalProperties:false, enums OK), so it uses z.enum freely — unlike the
// card agents, which must stay portable across all three providers.

// ---------------------------------------------------------------------------
// INPUT: the USGA data pulled from the usga_* tables for the chosen facility.
// Shapes mirror the schema columns (see pkg/api/schema.ts usga_*).
// ---------------------------------------------------------------------------

export const UsgaTeeData = z.object({
  teeId: z.number().int(),
  name: z.string(),
  gender: z.string(), // "M" | "F" as reported by the USGA
  par: z.number().int().nullable(),
  courseRating: z.number().nullable(),
  bogeyRating: z.number().nullable(),
  slopeRating: z.number().int().nullable(),
  length: z.number().int().nullable(),
  front9CourseRating: z.number().nullable(),
  front9SlopeRating: z.number().int().nullable(),
  back9CourseRating: z.number().nullable(),
  back9SlopeRating: z.number().int().nullable(),
});
export type UsgaTeeDataSchema = z.infer<typeof UsgaTeeData>;

// A USGA "course" is one rated nine-hole COMBINATION (e.g. "WHITE/BLUE").
export const UsgaCourseData = z.object({
  courseId: z.number().int(),
  name: z.string(),
  fullName: z.string(),
  tees: z.array(UsgaTeeData),
});
export type UsgaCourseDataSchema = z.infer<typeof UsgaCourseData>;

export const UsgaFacilityData = z.object({
  facilityId: z.number().int(),
  name: z.string(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  courses: z.array(UsgaCourseData),
});
export type UsgaFacilityDataSchema = z.infer<typeof UsgaFacilityData>;

// ---------------------------------------------------------------------------
// OUTPUT: the CourseProposal — the app's course concept, ready to review/save.
// ---------------------------------------------------------------------------

export const ProposalHole = z.object({
  number: z.number().int().min(1).max(18),
  par: z.number().int(),
  yardage: z.number().int().nullable(),
});
export type ProposalHoleSchema = z.infer<typeof ProposalHole>;

export const ProposalTee = z.object({
  name: z.string().describe('The tee\'s printed name ("Blue", "White/Gold", …).'),
  gender: z
    .enum(["m", "f"])
    .nullable()
    .describe("The rated gender, or null if the tee isn't gender-specific."),
  type: z
    .enum(TEES)
    .nullable()
    .describe(
      'The app-level tee category. Combination tees (a slashed name like "Blue/White") are ' +
        "always null. Otherwise assign outward from the regular tee along tips→back→standard→" +
        "senior→front→junior (junior is most forward), never skipping a rung: no 'tips' without " +
        "a separate 'back', no 'junior' without a 'front'. Null when unclear.",
    ),
  courseRating: z
    .number()
    .nullable()
    .describe("The 9-HOLE USGA course rating for this nine from this tee (null = unrated)."),
  slopeRating: z
    .number()
    .int()
    .nullable()
    .describe("The 9-HOLE USGA slope rating (55–155) for this nine from this tee (null)."),
  usgaTeeId: z
    .number()
    .int()
    .nullable()
    .describe("The usga_tee.tee_id this tee's ratings were taken from, or null if none matched."),
  holes: z.array(ProposalHole),
});
export type ProposalTeeSchema = z.infer<typeof ProposalTee>;

export const ProposalSet = z.object({
  name: z.string().describe('The nine\'s name ("White Oak", "Blue Spruce", …).'),
  usgaCourseId: z
    .number()
    .int()
    .nullable()
    .describe("The usga_course.course_id (nine-combination) this nine is half of, or null."),
  usgaCourseNine: z
    .enum(["front", "back"])
    .nullable()
    .describe("Which half of that combination this nine is (front = holes 1–9), or null."),
  tees: z.array(ProposalTee),
});
export type ProposalSetSchema = z.infer<typeof ProposalSet>;

export const CourseProposal = z.object({
  name: z.string().describe("The course/facility name."),
  location: z.string().nullable().describe('A human location ("Buck Hill Falls, PA"), or null.'),
  ncrdbFacilityId: z
    .number()
    .int()
    .nullable()
    .describe("The USGA NCRDB facility id this course maps to, or null."),
  sets: z.array(ProposalSet).describe("One entry per nine printed on the card."),
});
export type CourseProposalSchema = z.infer<typeof CourseProposal>;
