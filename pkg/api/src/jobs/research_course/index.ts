import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { scorecard, usgaCourse, usgaFacility, usgaTee } from "../../../schema";
import { CardMetadata } from "../../agent/card_metadata/schema";
import { researchCourse } from "../../agent/research_course/agent";
import { CourseProposal, type UsgaFacilityDataSchema } from "../../agent/research_course/schema";
import { resolveModel } from "../../model";
import { createJobType } from "../common";

// Reconciles a scorecard's extracted layout (from the extract_metadata job)
// with the USGA NCRDB mirror rows for a facility into a CourseProposal the
// admin reviews and saves. Chained after extract_metadata: the FE submits this
// once the metadata job completes and the admin has picked the facility, so the
// metadata result is already committed on its job row. Part of the admin
// course-creation flow.
export const researchCourseJob = createJobType({
  name: "research_course",
  args: z.object({ scorecardId: z.uuid(), facilityId: z.number().int() }),
  result: CourseProposal,
  async execute(ctx, { scorecardId, facilityId }) {
    const { env } = ctx;
    const db = getDb(env.DB);

    await ctx.report({ message: "Loading the extracted layout…" });
    const card = await db.query.scorecard.findFirst({
      where: eq(scorecard.id, scorecardId),
      with: { extractMetadataJob: true },
    });
    const metadataJob = card?.extractMetadataJob;
    if (!metadataJob) throw new Error("No metadata extraction found for this scorecard");
    if (metadataJob.state !== "ok") {
      throw new Error(`Metadata extraction has not completed (state: ${metadataJob.state})`);
    }
    const metadata = CardMetadata.parse(metadataJob.result);

    await ctx.report({ message: "Pulling USGA ratings…" });
    const facility = await db.query.usgaFacility.findFirst({
      where: eq(usgaFacility.facilityId, facilityId),
    });
    if (!facility) throw new Error(`USGA facility ${facilityId} not found`);
    const courses = await db.query.usgaCourse.findMany({
      where: eq(usgaCourse.facilityId, facilityId),
    });
    const courseIds = courses.map((course) => course.courseId);
    const tees =
      courseIds.length > 0
        ? await db.query.usgaTee.findMany({ where: inArray(usgaTee.courseId, courseIds) })
        : [];

    const usga: UsgaFacilityDataSchema = {
      facilityId: facility.facilityId,
      name: facility.name,
      state: facility.state ?? null,
      country: facility.country ?? null,
      courses: courses.map((course) => ({
        courseId: course.courseId,
        name: course.name,
        fullName: course.fullName,
        tees: tees
          .filter((tee) => tee.courseId === course.courseId)
          .map((tee) => ({
            teeId: tee.teeId,
            name: tee.name,
            gender: tee.gender,
            par: tee.par ?? null,
            courseRating: tee.courseRating ?? null,
            bogeyRating: tee.bogeyRating ?? null,
            slopeRating: tee.slopeRating ?? null,
            length: tee.length ?? null,
            front9CourseRating: tee.front9CourseRating ?? null,
            front9SlopeRating: tee.front9SlopeRating ?? null,
            back9CourseRating: tee.back9CourseRating ?? null,
            back9SlopeRating: tee.back9SlopeRating ?? null,
          })),
      })),
    };

    await ctx.report({ message: "Reconciling the course…" });
    return await researchCourse({ metadata, usga, resolver: (spec) => resolveModel(env, spec) });
  },
});
