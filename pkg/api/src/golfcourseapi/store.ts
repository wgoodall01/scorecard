import { inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { gcapiCourse } from "../../schema";
import { GolfCourseApiCourse, type GolfCourseApiCourseSchema } from "./schema";

// The audit columns are app-level drizzle defaults; onConflictDoUpdate's SET
// isn't an .update(), so $onUpdateFn doesn't fire and updated_at is set here.
const isoNow = () => new Date().toISOString();

// The local mirror of GolfCourseAPI's course catalog (the `gcapi_course` table).
// Every upstream response is written here, which buys two things against a
// 50-request/day quota: searches that cost nothing, and stable addressability —
// a course is identified by its id, not by a text query we hope still returns it.

/** Write (or refresh) the mirror rows for a batch of courses from upstream. */
export async function storeGolfCourses(
  db: Db,
  courses: GolfCourseApiCourseSchema[],
): Promise<void> {
  if (courses.length === 0) return;

  const now = isoNow();
  const rows = courses.map((course) => ({
    courseId: course.id,
    clubName: course.club_name,
    courseName: course.course_name,
    city: course.location?.city ?? null,
    state: course.location?.state ?? null,
    country: course.location?.country ?? null,
    payload: course,
    fetchedAt: now,
  }));

  // One statement: re-seeing a course refreshes its payload and fetched_at.
  await db
    .insert(gcapiCourse)
    .values(rows)
    .onConflictDoUpdate({
      target: gcapiCourse.courseId,
      set: {
        clubName: sql`excluded.club_name`,
        courseName: sql`excluded.course_name`,
        city: sql`excluded.city`,
        state: sql`excluded.state`,
        country: sql`excluded.country`,
        payload: sql`excluded.payload`,
        fetchedAt: sql`excluded.fetched_at`,
        updatedAt: now,
      },
    });
}

// A stored row's payload, re-parsed. Parsing rather than casting means a row
// written by an older schema version surfaces as a clear error here instead of
// as a confusing shape downstream.
function coursesFromRows(rows: { payload: unknown }[]): GolfCourseApiCourseSchema[] {
  return rows.map((row) => GolfCourseApiCourse.parse(row.payload));
}

/**
 * Search the mirror by club or layout name (SQLite LIKE is case-insensitive for
 * ASCII, so this is an ILIKE). Free — no upstream request, no quota.
 */
export async function searchStoredGolfCourses(
  db: Db,
  query: string,
  limit = 200,
): Promise<GolfCourseApiCourseSchema[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const pattern = `%${trimmed}%`;

  const rows = await db.query.gcapiCourse.findMany({
    where: or(like(gcapiCourse.clubName, pattern), like(gcapiCourse.courseName, pattern)),
    // A club's rated layouts must arrive together for the layout adapter to fold
    // them; ordering by club keeps a truncated page from splitting one.
    orderBy: [gcapiCourse.clubName, gcapiCourse.courseId],
    limit,
  });
  return coursesFromRows(rows);
}

/** Load specific courses by GolfCourseAPI id. Order is not preserved. */
export async function getStoredGolfCourses(
  db: Db,
  courseIds: number[],
): Promise<GolfCourseApiCourseSchema[]> {
  if (courseIds.length === 0) return [];
  const rows = await db.query.gcapiCourse.findMany({
    where: inArray(gcapiCourse.courseId, courseIds),
    orderBy: [gcapiCourse.courseId],
  });
  return coursesFromRows(rows);
}
