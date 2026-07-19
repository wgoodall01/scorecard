import { asc, eq, inArray, isNull, like } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import {
  course,
  courseSet,
  courseSetTee,
  hole,
  job,
  scorecard,
  usgaFacility,
  uuidv7,
} from "../schema";
import { CourseProposal } from "../src/agent/research_course/schema";
import type { CourseProposalSchema } from "../src/agent/research_course/schema";
import type { JobErrorSchema } from "../src/jobs/common";
import { submit } from "../src/jobs/client";
import { requireAdmin, requireAuth } from "./shared";

function jobErrorMessage(error: JobErrorSchema | null): string {
  if (error?.name === "ScorecardReadError") return `Couldn't read the scorecard: ${error.message}`;
  return error?.message ?? "Service Error";
}

// The saved-course request is a (reviewed, possibly edited) CourseProposal
// plus: the source scorecard (recorded as course.imported_scorecard_id) and
// the nine names the admin explicitly removed (archived, soft-deleted). Both
// are absent for a plain scrape/edit.
const SaveCourseRequest = CourseProposal.extend({
  scorecardId: z.string().min(1).nullable().optional(),
  archiveSetNames: z.array(z.string()).optional(),
});

export const courseRoutes = new Hono<Env>()
  // Typeahead over the USGA facility mirror. Admin-only (it drives the
  // create-course flow). Flags facilities we've already imported so the UI can
  // say so / route to a merge.
  .get("/courses/facilities", requireAuth, requireAdmin, async (c) => {
    const query = c.req.query("q")?.trim() ?? "";
    if (query.length < 2) return c.json({ facilities: [] });

    const db = getDb(c.env.DB);
    const facilities = await db.query.usgaFacility.findMany({
      where: like(usgaFacility.name, `%${query}%`),
      orderBy: [asc(usgaFacility.name)],
      limit: 20,
    });
    const facilityIds = facilities.map((facility) => facility.facilityId);
    const existing =
      facilityIds.length > 0
        ? await db.query.course.findMany({ where: inArray(course.ncrdbFacilityId, facilityIds) })
        : [];
    const existingByFacility = new Map(
      existing
        .filter((row) => row.ncrdbFacilityId !== null)
        .map((row) => [row.ncrdbFacilityId, row.id] as const),
    );

    return c.json({
      facilities: facilities.map((facility) => ({
        facilityId: facility.facilityId,
        name: facility.name,
        state: facility.stateDisplay ?? facility.state,
        country: facility.country,
        existingCourseId: existingByFacility.get(facility.facilityId) ?? null,
      })),
    });
  })
  // Kick off the course-ingest (research_course) job for a scorecard +
  // facility, once the metadata extraction has completed and the admin has
  // picked the facility. Returns the job id — poll GET /courses/research/:jobId.
  .put("/courses/research", requireAuth, requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({ scorecardId: z.string().min(1), facilityId: z.number().int() })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "scorecardId and facilityId are required" }, 400);
    const { scorecardId, facilityId } = parsed.data;

    const db = getDb(c.env.DB);
    const row = await db.query.scorecard.findFirst({ where: eq(scorecard.id, scorecardId) });
    if (!row) return c.json({ error: "Scorecard not found" }, 404);

    const handle = await submit(c.env, { _job: "research_course", scorecardId, facilityId });
    // Record the link on the card for provenance (polling is by job id, not
    // via the card).
    await db
      .update(scorecard)
      .set({ researchCourseJobId: handle.id })
      .where(eq(scorecard.id, scorecardId));

    return c.json({ jobId: handle.id }, 202);
  })
  // Poll a course-ingest job by id: 202 while pending, the CourseProposal when
  // done, 500 on failure.
  .get("/courses/research/:jobId", requireAuth, requireAdmin, async (c) => {
    const db = getDb(c.env.DB);
    const jobRow = await db.query.job.findFirst({ where: eq(job.id, c.req.param("jobId")) });
    if (!jobRow || jobRow.jobType !== "research_course") {
      return c.json({ error: "Job not found" }, 404);
    }
    if (jobRow.state === "running") return c.json({ status: "pending" as const }, 202);
    if (jobRow.state === "error") {
      return c.json(
        { error: jobErrorMessage((jobRow.error as JobErrorSchema | null) ?? null) },
        500,
      );
    }
    return c.json(jobRow.result as CourseProposalSchema);
  })
  // The existing app course for a USGA facility (with its full nine/tee/hole
  // tree), or null — powers the before/after toggle when merging.
  .get("/courses/facility/:facilityId", requireAuth, requireAdmin, async (c) => {
    const facilityId = Number(c.req.param("facilityId"));
    if (!Number.isInteger(facilityId)) return c.json({ error: "Invalid facility id" }, 400);

    const db = getDb(c.env.DB);
    const existing = await db.query.course.findFirst({
      where: eq(course.ncrdbFacilityId, facilityId),
      with: {
        // Active nines only — the editor works on the live course; archived
        // ones are gone from the create/edit surface.
        sets: {
          where: isNull(courseSet.archivedAt),
          orderBy: [asc(courseSet.name)],
          with: { tees: { orderBy: [asc(courseSetTee.name)], with: { holes: true } } },
        },
      },
    });
    return c.json({ course: existing ?? null });
  })
  // Save a reviewed proposal: create a new course, or MERGE into the existing
  // one for this facility — matching by natural key (course by facility id,
  // set by name, tee by (name,gender), hole by number) so existing ids (and
  // the historical scores hanging off them) are preserved. Rows are never
  // deleted: a tee dropped from the card just stays.
  .post("/courses", requireAuth, requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SaveCourseRequest.safeParse(body);
    if (!parsed.success) return c.json({ error: "A valid course is required" }, 400);
    const proposal = parsed.data;
    if (proposal.sets.length === 0) {
      return c.json({ error: "A course needs at least one nine" }, 400);
    }

    const db = getDb(c.env.DB);

    // Merge target: the existing course sharing this facility id, loaded with
    // its full tree so we can match children by natural key.
    const existingCourse =
      proposal.ncrdbFacilityId !== null
        ? await db.query.course.findFirst({
            where: eq(course.ncrdbFacilityId, proposal.ncrdbFacilityId),
            with: { sets: { with: { tees: { with: { holes: true } } } } },
          })
        : undefined;

    const batch: Parameters<typeof db.batch>[0][number][] = [];
    const courseId = existingCourse?.id ?? uuidv7();

    const importedScorecardId = proposal.scorecardId ?? null;
    if (existingCourse) {
      batch.push(
        db
          .update(course)
          .set({
            name: proposal.name,
            location: proposal.location,
            ncrdbFacilityId: proposal.ncrdbFacilityId,
            // Record the latest import source; leave it untouched on a plain
            // edit (no scorecard in play).
            importedScorecardId: importedScorecardId ?? undefined,
          })
          .where(eq(course.id, courseId)),
      );
    } else {
      batch.push(
        db.insert(course).values({
          id: courseId,
          name: proposal.name,
          location: proposal.location,
          ncrdbFacilityId: proposal.ncrdbFacilityId,
          importedScorecardId,
        }),
      );
    }

    const existingSets = new Map(
      (existingCourse?.sets ?? []).map((set) => [set.name.toLowerCase(), set] as const),
    );

    for (const setProposal of proposal.sets) {
      const existingSet = existingSets.get(setProposal.name.toLowerCase());
      const courseSetId = existingSet?.id ?? uuidv7();

      if (existingSet) {
        batch.push(
          db
            .update(courseSet)
            .set({
              usgaCourseId: setProposal.usgaCourseId,
              usgaCourseNine: setProposal.usgaCourseNine,
              // A nine present in the proposal is active — un-archive if it was.
              archivedAt: null,
            })
            .where(eq(courseSet.id, courseSetId)),
        );
      } else {
        batch.push(
          db.insert(courseSet).values({
            id: courseSetId,
            courseId,
            name: setProposal.name,
            usgaCourseId: setProposal.usgaCourseId,
            usgaCourseNine: setProposal.usgaCourseNine,
          }),
        );
      }

      const existingTees = new Map(
        (existingSet?.tees ?? []).map((tee): [string, typeof tee] => [
          `${tee.name.toLowerCase()}/${tee.gender ?? ""}`,
          tee,
        ]),
      );

      for (const teeProposal of setProposal.tees) {
        const teeKey = `${teeProposal.name.toLowerCase()}/${teeProposal.gender ?? ""}`;
        const existingTee = existingTees.get(teeKey);
        const teeId = existingTee?.id ?? uuidv7();

        if (existingTee) {
          batch.push(
            db
              .update(courseSetTee)
              .set({
                type: teeProposal.type,
                courseRating: teeProposal.courseRating,
                slopeRating: teeProposal.slopeRating,
                usgaTeeId: teeProposal.usgaTeeId,
              })
              .where(eq(courseSetTee.id, teeId)),
          );
        } else {
          batch.push(
            db.insert(courseSetTee).values({
              id: teeId,
              courseSetId,
              name: teeProposal.name,
              gender: teeProposal.gender,
              type: teeProposal.type,
              courseRating: teeProposal.courseRating,
              slopeRating: teeProposal.slopeRating,
              usgaTeeId: teeProposal.usgaTeeId,
            }),
          );
        }

        const existingHoles = new Map(
          (existingTee?.holes ?? []).map((entry) => [entry.number, entry] as const),
        );

        for (const holeProposal of teeProposal.holes) {
          const existingHole = existingHoles.get(holeProposal.number);
          if (existingHole) {
            batch.push(
              db
                .update(hole)
                .set({ par: holeProposal.par, yardage: holeProposal.yardage })
                .where(eq(hole.id, existingHole.id)),
            );
          } else {
            batch.push(
              db.insert(hole).values({
                courseSetTeeId: teeId,
                number: holeProposal.number,
                par: holeProposal.par,
                yardage: holeProposal.yardage,
              }),
            );
          }
        }
      }
    }

    // Soft-delete the nines the admin explicitly removed (edit flow). We never
    // hard-delete — historical scores hang off these sets' holes by id and must
    // keep resolving; archiving just hides them from every new-score path.
    const now = new Date().toISOString();
    for (const name of proposal.archiveSetNames ?? []) {
      const set = existingSets.get(name.toLowerCase());
      if (set) {
        batch.push(db.update(courseSet).set({ archivedAt: now }).where(eq(courseSet.id, set.id)));
      }
    }

    await db.batch(batch as [(typeof batch)[number], ...typeof batch]);
    return c.json({ courseId }, existingCourse ? 200 : 201);
  });
