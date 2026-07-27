import { describe, expect, it } from "vitest";
import buckHillSearch from "../../golfcourseapi/testdata/buck-hill-falls-search.json";
import { GolfCourseApiSearchResponse } from "../../golfcourseapi/schema";
import { layoutFromGolfCourseApi, layoutGaps } from "./layout";

// The fixture is a REAL, unedited GolfCourseAPI /v1/search response for "buck
// hill falls" (captured 2026-07-27). Buck Hill is the ideal regression case:
// it's the course seeded in seed/courses.yaml from our production rows, which
// were imported from the USGA, so its pars and yardages are independently known
// ground truth — and it's a three-nine club, which is what makes the
// nine-combination folding non-trivial.
const courses = GolfCourseApiSearchResponse.parse(buckHillSearch).courses;

// From seed/courses.yaml — White Oak, Blue tee (the USGA-imported production
// rows). GolfCourseAPI must reproduce these exactly.
const WHITE_OAK_BLUE_PARS = [4, 5, 4, 5, 4, 4, 3, 4, 3];
const WHITE_OAK_BLUE_YARDAGES = [343, 510, 336, 563, 387, 392, 161, 432, 207];
// White Oak, Blue/White (a combination tee rated only on the White/Blue layout).
const WHITE_OAK_BLUE_WHITE_YARDAGES = [343, 475, 336, 563, 361, 382, 149, 410, 207];
// The men's stroke-index row for the White nine — the odds out of the
// combination's 1-18. The women's row is a DIFFERENT ranking (see below).
const WHITE_OAK_MENS_STROKE_INDEX = [13, 5, 11, 1, 7, 9, 17, 3, 15];
const WHITE_OAK_WOMENS_STROKE_INDEX = [11, 1, 13, 3, 5, 9, 17, 7, 15];

describe("layoutFromGolfCourseApi", () => {
  const layout = layoutFromGolfCourseApi(courses);

  it("folds the nine-combinations into one nine per physical nine", () => {
    expect(layout.source).toBe("golfcourseapi");
    // Three rated layouts (White/Blue, Blue/Red, Red/White) = six halves, but
    // only three distinct nines.
    expect(layout.nines.map((nine) => nine.name).sort()).toEqual(["Blue", "Red", "White"]);
  });

  it("numbers every nine 1-9 by preferring its front-half occurrence", () => {
    // Each Buck Hill nine fronts one combination, so all three come out
    // numbered 1-9 — matching the production rows, where every nine is the
    // front half of its USGA course.
    for (const nine of layout.nines) {
      for (const tee of nine.tees) {
        expect(tee.holes.map((hole) => hole.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      }
    }
  });

  it("reproduces the production pars and yardages exactly", () => {
    const white = layout.nines.find((nine) => nine.name === "White");
    const blue = white?.tees.find((tee) => tee.name === "Blue" && tee.gender === "m");
    expect(blue?.holes.map((hole) => hole.par)).toEqual(WHITE_OAK_BLUE_PARS);
    expect(blue?.holes.map((hole) => hole.yardage)).toEqual(WHITE_OAK_BLUE_YARDAGES);
  });

  it("carries the printed stroke index through, per gender", () => {
    const white = layout.nines.find((nine) => nine.name === "White");
    const mens = white?.tees.find((tee) => tee.name === "Blue" && tee.gender === "m");
    const womens = white?.tees.find((tee) => tee.name === "Blue" && tee.gender === "f");
    // A nine carries nine indexes out of its combination's 1-18, and the men's
    // and women's rankings genuinely differ — which is exactly why the stroke
    // index has to be stored per tee row rather than per nine.
    expect(mens?.holes.map((hole) => hole.strokeIndex)).toEqual(WHITE_OAK_MENS_STROKE_INDEX);
    expect(womens?.holes.map((hole) => hole.strokeIndex)).toEqual(WHITE_OAK_WOMENS_STROKE_INDEX);
  });

  it("keeps both gender variants of a tee as separate rows", () => {
    const white = layout.nines.find((nine) => nine.name === "White");
    const blues = white?.tees.filter((tee) => tee.name === "Blue") ?? [];
    expect(blues.map((tee) => tee.gender).sort()).toEqual(["f", "m"]);
    // Same physical tee, so the yardages are identical — what differs is the
    // rating (which doesn't come from here) and the stroke index.
    expect(blues[0]?.holes.map((hole) => hole.yardage)).toEqual(
      blues[1]?.holes.map((hole) => hole.yardage),
    );
  });

  it("unions tees across the combinations a nine appears in", () => {
    // "Blue/White" is rated on the White/Blue layout only. The White nine's
    // canonical numbering comes from that same layout, but the Blue nine's
    // comes from Blue/Red — so Blue only gets its Blue/White row if tees are
    // unioned across occurrences and renumbered.
    const blue = layout.nines.find((nine) => nine.name === "Blue");
    const combination = blue?.tees.find((tee) => tee.name === "Blue/White");
    expect(combination).toBeDefined();
    expect(combination?.holes.map((hole) => hole.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // And the White nine's own Blue/White row keeps its native numbering.
    const white = layout.nines.find((nine) => nine.name === "White");
    const whiteCombination = white?.tees.find((tee) => tee.name === "Blue/White");
    expect(whiteCombination?.holes.map((hole) => hole.yardage)).toEqual(
      WHITE_OAK_BLUE_WHITE_YARDAGES,
    );
  });

  it("splits an unnamed 18 into Front and Back", () => {
    const plain = layoutFromGolfCourseApi([
      {
        ...courses[0],
        course_name: "Skytop Lodge",
        tees: { male: [courses[0].tees.male[0]], female: [] },
      },
    ]);
    expect(plain.nines.map((nine) => nine.name)).toEqual(["Front", "Back"]);
    expect(plain.nines[0].tees[0].holes.map((hole) => hole.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(plain.nines[1].tees[0].holes.map((hole) => hole.number)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
  });
});

describe("layoutGaps", () => {
  it("blocks when there is no layout at all", () => {
    expect(layoutGaps(null)).toEqual([
      {
        severity: "blocking",
        message: "we don't have this course's layout — no nines, tees, or pars",
      },
    ]);
  });

  it("has no blocking gap for a complete GolfCourseAPI layout", () => {
    const gaps = layoutGaps(layoutFromGolfCourseApi(courses));
    expect(gaps.filter((gap) => gap.severity === "blocking")).toEqual([]);
    // ...but does flag that the nines are named for their tee colors, since
    // Buck Hill's card actually prints "White Oak" / "Blue Spruce" / "Red Maple".
    expect(gaps.some((gap) => gap.message.includes("tee colors"))).toBe(true);
  });
});
