import { z } from "zod";

// The GolfCourseAPI (api.golfcourseapi.com) wire shapes. Their OpenAPI spec
// lives at https://api.golfcourseapi.com/docs/api/openapi.yml.
//
// These schemas are deliberately LENIENT about absence: the published spec
// documents plenty of fields the live data doesn't actually carry, so anything
// we don't strictly need is optional and defaults to null rather than failing
// the parse. Verified against three facilities (Buck Hill Falls, Skytop,
// Pinehurst) on 2026-07-27:
//
//   - per-hole par, yardage, and stroke index ("handicap") are ALWAYS present,
//     per tee, per gender — and Buck Hill's pars/yardages match our
//     USGA-imported production rows exactly.
//   - front_/back_ 9-hole rating splits and bogey_rating are documented but
//     NEVER populated (0 of 60+ tees). This is why GolfCourseAPI is a LAYOUT
//     source only: the 9-hole ratings a nine needs to post scores still come
//     from the USGA NCRDB mirror, which research_course reconciles against.
//   - there is no facility concept and no NCRDB id — a multi-nine club shows up
//     as one "course" per rated nine-combination, named like "White/Blue",
//     sharing a club_name.

// A nullable number that also tolerates the field being absent entirely.
const optionalNumber = z
  .number()
  .nullish()
  .transform((value) => value ?? null);
const optionalInt = z
  .number()
  .int()
  .nullish()
  .transform((value) => value ?? null);
const optionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

export const GolfCourseApiHole = z.object({
  par: optionalInt,
  yardage: optionalInt,
  // The printed stroke index — which holes get a handicap stroke first. We
  // don't get this off a scorecard photo, so it's new information.
  handicap: optionalInt,
});
export type GolfCourseApiHoleSchema = z.infer<typeof GolfCourseApiHole>;

export const GolfCourseApiTeeBox = z.object({
  tee_name: optionalString,
  // 18-hole ratings as printed. Kept for the length ordering that decides tee
  // categories; the 9-hole splits we'd actually need are never populated.
  course_rating: optionalNumber,
  slope_rating: optionalInt,
  total_yards: optionalInt,
  number_of_holes: optionalInt,
  par_total: optionalInt,
  holes: z.array(GolfCourseApiHole).default([]),
});
export type GolfCourseApiTeeBoxSchema = z.infer<typeof GolfCourseApiTeeBox>;

export const GolfCourseApiLocation = z.object({
  address: optionalString,
  city: optionalString,
  state: optionalString,
  country: optionalString,
});
export type GolfCourseApiLocationSchema = z.infer<typeof GolfCourseApiLocation>;

// One rated 18-hole layout. At a multi-nine club this is a nine-COMBINATION
// (course_name "White/Blue"); at a plain 18-hole club it's the whole course.
export const GolfCourseApiCourse = z.object({
  id: z.number().int(),
  club_name: z.string(),
  course_name: optionalString,
  location: GolfCourseApiLocation.nullish().transform((value) => value ?? null),
  tees: z
    .object({
      male: z
        .array(GolfCourseApiTeeBox)
        .nullish()
        .transform((value) => value ?? []),
      female: z
        .array(GolfCourseApiTeeBox)
        .nullish()
        .transform((value) => value ?? []),
    })
    .nullish()
    .transform((value) => value ?? { male: [], female: [] }),
});
export type GolfCourseApiCourseSchema = z.infer<typeof GolfCourseApiCourse>;

export const GolfCourseApiSearchResponse = z.object({
  courses: z
    .array(GolfCourseApiCourse)
    .nullish()
    .transform((value) => value ?? []),
});
export type GolfCourseApiSearchResponseSchema = z.infer<typeof GolfCourseApiSearchResponse>;
