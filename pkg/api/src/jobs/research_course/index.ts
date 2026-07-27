import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { scorecard, usgaCourse, usgaFacility, usgaTee } from "../../../schema";
import { CardMetadata } from "../../agent/card_metadata/schema";
import { researchCourse } from "../../agent/research_course/agent";
import {
  layoutFromCardMetadata,
  layoutFromGolfCourseApi,
  type CourseLayoutSchema,
} from "../../agent/research_course/layout";
import { CourseProposal, type UsgaFacilityDataSchema } from "../../agent/research_course/schema";
import { searchGolfCourses } from "../../golfcourseapi/client";
import { resolveModel } from "../../model";
import { createJobType } from "../common";

// Reconciles a course's LAYOUT with the USGA NCRDB mirror rows for a facility
// into a CourseProposal the admin reviews and saves.
//
// The layout comes from GolfCourseAPI (authoritative pars/yardages/stroke
// indexes — see src/golfcourseapi) and/or a scorecard photo read by the
// extract_metadata job. Normally it's just GolfCourseAPI; the flow only asks
// for a photo when the feed is missing or has gaps (layoutGaps), and then BOTH
// are passed so the agent can take the printed nine names off the card and
// everything else from the feed. Ratings always come from the USGA mirror —
// GolfCourseAPI documents 9-hole rating splits but never populates them.
//
// Part of the admin course-creation flow.
export const researchCourseJob = createJobType({
  name: "research_course",
  args: z.object({
    facilityId: z.number().int(),
    // GolfCourseAPI: the club name to search and which of its rated layouts to
    // use (a multi-nine club returns one per nine-combination). Empty = no feed
    // for this course, in which case a scorecard is required.
    golfCourseApi: z
      .object({ query: z.string().min(1), courseIds: z.array(z.number().int()).min(1) })
      .nullable(),
    // A captured card whose extract_metadata job has completed, or null.
    scorecardId: z.uuid().nullable(),
  }),
  result: CourseProposal,
  async execute(ctx, { facilityId, golfCourseApi, scorecardId }) {
    const { env } = ctx;
    const db = getDb(env.DB);

    // Authoritative-first: the structured feed, then the photo reading.
    const layouts: CourseLayoutSchema[] = [];

    if (golfCourseApi !== null) {
      await ctx.report({ message: "Pulling the course layout…" });
      const wanted = new Set(golfCourseApi.courseIds);
      const courses = (await searchGolfCourses(env, golfCourseApi.query)).filter((course) =>
        wanted.has(course.id),
      );
      if (courses.length === 0) {
        throw new Error("None of the selected GolfCourseAPI layouts came back from the search");
      }
      layouts.push(layoutFromGolfCourseApi(courses));
    }

    if (scorecardId !== null) {
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
      layouts.push(layoutFromCardMetadata(CardMetadata.parse(metadataJob.result)));
    }

    if (layouts.length === 0) {
      throw new Error(
        "No course layout to work from — pick a GolfCourseAPI course or upload a card",
      );
    }

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
    return await researchCourse({ layouts, usga, resolver: (spec) => resolveModel(env, spec) });
  },
});
