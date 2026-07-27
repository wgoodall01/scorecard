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
import { layoutFromGolfCourseApi, layoutGaps } from "../src/agent/research_course/layout";
import { GolfCourseApiError, searchGolfCoursesUpstream } from "../src/golfcourseapi/client";
import { getStoredGolfCourses, searchStoredGolfCourses } from "../src/golfcourseapi/store";
import type { JobErrorSchema, JobReportSchema } from "../src/jobs/common";
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
  // Look up a course's LAYOUT in GolfCourseAPI — the primary source of pars,
  // yardages, and stroke indexes for the create-course flow (see
  // src/golfcourseapi). Admin-only.
  //
  // MIRROR FIRST: the `gcapi_course` table holds every course any past search
  // returned, and searching it is free. Upstream is only touched when the mirror
  // has nothing (or `?refresh=1` forces it), because the free tier allows just 50
  // requests/day. A hit is reported as `source: "mirror"` so the UI can say where
  // the answer came from.
  //
  // Results are grouped by CLUB, because that's the unit the flow works in: a
  // multi-nine club comes back from GolfCourseAPI as one 18-hole entry per rated
  // nine-combination, and the layout adapter folds a club's whole set of them
  // into one nine per physical nine. Each group carries the folded nines and
  // any gaps, so the UI can show what it'd get and whether a scorecard photo is
  // still needed.
  .get("/courses/golfcourseapi", requireAuth, requireAdmin, async (c) => {
    const query = c.req.query("q")?.trim() ?? "";
    if (query.length < 3) return c.json({ clubs: [], source: "mirror" as const });
    const refresh = c.req.query("refresh") === "1";

    const db = getDb(c.env.DB);
    let courses = refresh ? [] : await searchStoredGolfCourses(db, query);
    let source: "mirror" | "upstream" = "mirror";

    if (courses.length === 0) {
      source = "upstream";
      try {
        courses = await searchGolfCoursesUpstream(c.env, query);
      } catch (error) {
        if (error instanceof GolfCourseApiError) return c.json({ error: error.message }, 502);
        throw error;
      }
    }

    const byClub = new Map<string, typeof courses>();
    for (const course of courses) {
      const group = byClub.get(course.club_name);
      if (group) group.push(course);
      else byClub.set(course.club_name, [course]);
    }

    return c.json({
      source,
      clubs: [...byClub.entries()].map(([clubName, group]) => {
        const layout = layoutFromGolfCourseApi(group);
        const place = group[0]?.location;
        return {
          clubName,
          // "Buck Hill Falls, PA" — the city/state pair, when they're there.
          location: [place?.city, place?.state].filter((part) => part != null).join(", ") || null,
          courseIds: group.map((course) => course.id),
          ratedLayouts: group.map((course) => course.course_name),
          nines: layout.nines.map((nine) => ({
            name: nine.name,
            tees: nine.tees.length,
            holes: nine.tees[0]?.holes.length ?? 0,
          })),
          gaps: layoutGaps(layout),
        };
      }),
    });
  })
  // Kick off the course-ingest (research_course) job for a facility, from a set
  // of mirrored GolfCourseAPI courses and/or a captured scorecard whose metadata
  // extraction has completed. Returns the job id — poll
  // GET /courses/research/:jobId.
  //
  // The layout is addressed by GolfCourseAPI course id, and the job reads those
  // rows out of the mirror — no text search to re-run, nothing to hope is still
  // cached. Ids are validated here so a typo fails the request rather than the
  // job.
  .put("/courses/research", requireAuth, requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        facilityId: z.number().int(),
        gcapiCourseIds: z
          .array(z.number().int())
          .nullish()
          .transform((value) => value ?? []),
        scorecardId: z
          .string()
          .min(1)
          .nullish()
          .transform((value) => value ?? null),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "facilityId and at least one layout source are required" }, 400);
    }
    const { facilityId, gcapiCourseIds, scorecardId } = parsed.data;
    if (gcapiCourseIds.length === 0 && scorecardId === null) {
      return c.json({ error: "Pick a GolfCourseAPI club or upload a scorecard" }, 400);
    }

    const db = getDb(c.env.DB);
    if (scorecardId !== null) {
      const row = await db.query.scorecard.findFirst({ where: eq(scorecard.id, scorecardId) });
      if (!row) return c.json({ error: "Scorecard not found" }, 404);
    }
    if (gcapiCourseIds.length > 0) {
      const known = await getStoredGolfCourses(db, gcapiCourseIds);
      if (known.length !== gcapiCourseIds.length) {
        return c.json({ error: "Some of those GolfCourseAPI courses aren't mirrored" }, 400);
      }
    }

    const handle = await submit(c.env, {
      _job: "research_course",
      facilityId,
      gcapiCourseIds,
      scorecardId,
    });
    // Record the link on the card for provenance (polling is by job id, not
    // via the card).
    if (scorecardId !== null) {
      await db
        .update(scorecard)
        .set({ researchCourseJobId: handle.id })
        .where(eq(scorecard.id, scorecardId));
    }

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
    if (jobRow.state === "queued" || jobRow.state === "working") {
      const report = (jobRow.status as JobReportSchema | null) ?? null;
      return c.json({ status: "pending" as const, message: report?.message ?? null }, 202);
    }
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
            // Re-importing/editing a course revives it if it was archived.
            archivedAt: null,
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
                .set({
                  par: holeProposal.par,
                  yardage: holeProposal.yardage,
                  strokeIndex: holeProposal.strokeIndex,
                })
                .where(eq(hole.id, existingHole.id)),
            );
          } else {
            batch.push(
              db.insert(hole).values({
                courseSetTeeId: teeId,
                number: holeProposal.number,
                par: holeProposal.par,
                yardage: holeProposal.yardage,
                strokeIndex: holeProposal.strokeIndex,
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
  })
  // Admin-only soft delete: archive a course and its nines. Never a hard
  // delete — historical scores hang off these nines' holes by id — so the rows
  // stay and just drop out of the registry and every new-score path.
  .post("/courses/:id/archive", requireAuth, requireAdmin, async (c) => {
    const db = getDb(c.env.DB);
    const id = c.req.param("id");
    const existing = await db.query.course.findFirst({ where: eq(course.id, id) });
    if (!existing) return c.json({ error: "Course not found" }, 404);

    const now = new Date().toISOString();
    await db.batch([
      db.update(course).set({ archivedAt: now }).where(eq(course.id, id)),
      db.update(courseSet).set({ archivedAt: now }).where(eq(courseSet.courseId, id)),
    ]);
    return c.json({ ok: true });
  });
