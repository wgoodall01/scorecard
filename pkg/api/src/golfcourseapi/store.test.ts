import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../db";
import { GolfCourseApiSearchResponse } from "./schema";
import { getStoredGolfCourses, searchStoredGolfCourses, storeGolfCourses } from "./store";
import buckHillSearch from "./testdata/buck-hill-falls-search.json";

// A real captured /v1/search response for "buck hill falls": three rated
// nine-combinations sharing one club_name.
const courses = GolfCourseApiSearchResponse.parse(buckHillSearch).courses;

// The pool's D1 storage persists across tests in this file.
beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM "gcapi_course"`).run();
});

describe("the GolfCourseAPI mirror", () => {
  it("stores one row per course and finds them by club name", async () => {
    const db = getDb(env.DB);
    await storeGolfCourses(db, courses);

    // Case-insensitive substring, so a partial club name is enough.
    const found = await searchStoredGolfCourses(db, "buck hill");
    expect(found).toHaveLength(3);
    expect(new Set(found.map((course) => course.club_name))).toEqual(
      new Set(["Buck Hill Falls Golf Club"]),
    );
    expect(found.map((course) => course.course_name).sort()).toEqual([
      "Blue/Red",
      "Red/White",
      "White/Blue",
    ]);
  });

  it("round-trips the full tee and hole tree through the payload column", async () => {
    const db = getDb(env.DB);
    await storeGolfCourses(db, courses);

    const [stored] = await getStoredGolfCourses(db, [13305]);
    const original = courses.find((course) => course.id === 13305)!;
    // The payload is kept verbatim, so a stored course is indistinguishable
    // from the one the API handed us — that's what lets the research job work
    // off ids alone.
    expect(stored).toEqual(original);
    expect(stored.tees.male[0].holes).toHaveLength(18);
  });

  it("also matches on the rated layout's name", async () => {
    const db = getDb(env.DB);
    await storeGolfCourses(db, courses);

    const found = await searchStoredGolfCourses(db, "white/blue");
    expect(found.map((course) => course.id)).toEqual([13305]);
  });

  it("refreshes an existing row rather than duplicating it", async () => {
    const db = getDb(env.DB);
    await storeGolfCourses(db, courses);
    const before = await db.query.gcapiCourse.findFirst();

    // Same ids, one renamed club — a later response wins.
    await storeGolfCourses(
      db,
      courses.map((course) => ({ ...course, club_name: "Buck Hill Falls GC" })),
    );

    const { results } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "gcapi_course"`).all<{
      n: number;
    }>();
    expect(results[0].n).toBe(3);
    expect(await searchStoredGolfCourses(db, "Buck Hill Falls GC")).toHaveLength(3);
    // created_at sticks from the first insert; fetched_at moves.
    const after = await db.query.gcapiCourse.findFirst();
    expect(after?.createdAt).toBe(before?.createdAt);
  });

  it("returns nothing for an unknown query or id, rather than throwing", async () => {
    const db = getDb(env.DB);
    expect(await searchStoredGolfCourses(db, "nowhere municipal")).toEqual([]);
    expect(await getStoredGolfCourses(db, [1])).toEqual([]);
    expect(await searchStoredGolfCourses(db, "   ")).toEqual([]);
    expect(await getStoredGolfCourses(db, [])).toEqual([]);
  });
});
