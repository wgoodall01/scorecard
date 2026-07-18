import { z } from "zod";

// One entry per extracted nine, in input order. Same provider
// structured-output constraints as the extraction schema: all fields
// required, null (never a missing key) for absence.
export const CourseSetMatch = z.object({
  nineName: z.string().nullable().describe("The nine's name exactly as it was given to you."),
  courseSetId: z
    .string()
    .nullable()
    .describe(
      "The id of the matched course set from searchCourses results, or null when no " +
        "set is a confident match.",
    ),
});
export type CourseSetMatchSchema = z.infer<typeof CourseSetMatch>;

export const CourseMatchAnswer = z.object({
  courseId: z
    .string()
    .nullable()
    .describe(
      "The id of the matched course from searchCourses results, or null when no course " +
        "is a confident match.",
    ),
  sets: z
    .array(CourseSetMatch)
    .describe("Exactly one entry per input nine, in the same order as the input."),
});
export type CourseMatchAnswerSchema = z.infer<typeof CourseMatchAnswer>;
