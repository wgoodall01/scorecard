import { and, asc, inArray, isNull, like } from "drizzle-orm";
import type { getDb } from "../../../db";
import { course, courseSet } from "../../../schema";
import type { CourseSearch, CourseSearchResult, CourseSetPars, CourseSetParsList } from "./agent";

const MAX_RESULTS = 5;

// Production CourseSearch: SQLite LIKE is case-insensitive for ASCII, which
// gives the ILIKE semantics the agent is prompted for. Matches course names
// and set names, and always returns whole courses with all of their sets.
export function courseSearchFromDb(db: ReturnType<typeof getDb>): CourseSearch {
  return async (query) => {
    const pattern = `%${query}%`;
    const courseHits = await db
      .select({ id: course.id })
      .from(course)
      .where(like(course.name, pattern))
      .limit(MAX_RESULTS);
    const setHits = await db
      .select({ id: courseSet.courseId })
      .from(courseSet)
      .where(and(like(courseSet.name, pattern), isNull(courseSet.archivedAt)))
      .limit(MAX_RESULTS);

    const ids = [...new Set([...courseHits, ...setHits].map((hit) => hit.id))].slice(
      0,
      MAX_RESULTS,
    );
    if (ids.length === 0) return [];

    const rows = await db.query.course.findMany({
      where: inArray(course.id, ids),
      with: {
        sets: {
          where: isNull(courseSet.archivedAt),
          orderBy: [asc(courseSet.name)],
          with: { tees: { with: { holes: { columns: { number: true } } } } },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      location: row.location,
      sets: row.sets.map((set) => ({
        id: set.id,
        name: set.name,
        holes: holeRange(set.tees.flatMap((tee) => tee.holes.map((teeHole) => teeHole.number))),
      })),
    }));
  };
}

// "1-9"-style label of a set's hole numbers, for the search results.
export function holeRange(numbers: number[]): string | null {
  if (numbers.length === 0) return null;
  return `${Math.min(...numbers)}-${Math.max(...numbers)}`;
}

// Production CourseSetParsList for the exact par-sequence phase: every set's
// hole layouts. Holes are per-TEE rows and pars can differ between tees, so
// a set contributes one entry per distinct layout among its tees (usually
// one — deduped by fingerprint so identical layouts don't read as ambiguous
// candidates). One query over the whole table — the course catalog is small.
export function courseSetParsFromDb(db: ReturnType<typeof getDb>): CourseSetParsList {
  return async () => {
    const sets = await db.query.courseSet.findMany({
      where: isNull(courseSet.archivedAt),
      with: { tees: { with: { holes: true } } },
    });
    return sets.flatMap((set) => {
      const layouts = new Map<string, CourseSetPars>();
      for (const tee of set.tees) {
        const holes = [...tee.holes]
          .sort((a, b) => a.number - b.number)
          .map((hole) => ({ number: hole.number, par: hole.par }));
        const fingerprint = holes.map((hole) => `${hole.number}:${hole.par}`).join(",");
        if (!layouts.has(fingerprint)) {
          layouts.set(fingerprint, { courseId: set.courseId, courseSetId: set.id, holes });
        }
      }
      return [...layouts.values()];
    });
  };
}

// Eval CourseSetParsList over an in-memory list.
export function courseSetParsFromList(sets: CourseSetPars[]): CourseSetParsList {
  return () => Promise.resolve(sets);
}

// Eval CourseSearch: the same case-insensitive substring semantics over an
// in-memory course list, so evals run in plain Bun with no database.
export function courseSearchFromList(courses: CourseSearchResult[]): CourseSearch {
  return (query) => {
    const needle = query.toLowerCase();
    return Promise.resolve(
      courses
        .filter(
          (found) =>
            found.name.toLowerCase().includes(needle) ||
            found.sets.some((set) => set.name.toLowerCase().includes(needle)),
        )
        .slice(0, MAX_RESULTS),
    );
  };
}
