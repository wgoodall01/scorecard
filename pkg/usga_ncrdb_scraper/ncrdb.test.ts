/**
 * Live integration tests against the USGA NCRDB.
 *
 * These hit the real ncrdb.usga.org endpoints, so they need network access.
 * Run with:  bun test
 */
import { expect, test, describe } from "bun:test";
import { searchCourses, describeCourse, type CourseInfo } from "./ncrdb";

// Buck Hill Falls Golf Club is a stable fixture with several course layouts.
let buckHill: CourseInfo[];

async function loadBuckHill(): Promise<CourseInfo[]> {
  if (!buckHill) buckHill = await searchCourses({ clubName: "buck hill" });
  return buckHill;
}

describe("searchCourses", () => {
  test('finds Buck Hill Falls layouts when searching "buck hill"', async () => {
    const courses = await loadBuckHill();
    expect(courses.length).toBeGreaterThan(0);
    // Every result should belong to the Buck Hill Falls facility.
    for (const c of courses) {
      expect(c.facilityName).toBe("Buck Hill Falls Golf Club");
    }
    // The known layouts include WHITE/BLUE, BLUE/RED and RED/WHITE.
    const names = courses.map((c) => c.courseName);
    expect(names).toContain("WHITE/BLUE");
    expect(names).toContain("BLUE/RED");
  });
});

describe("WHITE/BLUE course", () => {
  test('the "white/blue" layout is present and identifiable', async () => {
    const courses = await loadBuckHill();
    const whiteBlue = courses.find((c) => c.courseName === "WHITE/BLUE");
    expect(whiteBlue).toBeDefined();
    expect(whiteBlue!.fullName).toBe("Buck Hill Falls Golf Club - WHITE/BLUE");
    expect(whiteBlue!.stateDisplay).toBe("PA");
  });

  test("men's White tees have the expected ratings", async () => {
    const courses = await loadBuckHill();
    const whiteBlue = courses.find((c) => c.courseName === "WHITE/BLUE")!;
    const tees = await describeCourse(whiteBlue.courseID);

    const mensWhite = tees.find((t) => t.gender === "M" && t.teeName === "White");
    expect(mensWhite).toBeDefined();
    expect(mensWhite).toMatchObject({
      teeName: "White",
      gender: "M",
      par: 72,
      courseRating: 69.8,
      bogeyRating: 93.1,
      slopeRating: 126,
    });
    // The tee should carry a numeric USGA tee id.
    expect(typeof mensWhite!.teeId).toBe("number");
  });
});

describe("BLUE/RED course", () => {
  test("women's Red tees: front-nine rating and slope", async () => {
    const courses = await loadBuckHill();
    const blueRed = courses.find((c) => c.courseName === "BLUE/RED")!;
    expect(blueRed).toBeDefined();

    const tees = await describeCourse(blueRed.courseID);
    const womensRed = tees.find((t) => t.gender === "F" && t.teeName === "Red");
    expect(womensRed).toBeDefined();

    // Front nine of the women's Red tee.
    expect(womensRed!.front9).toEqual({
      courseRating: 34.8,
      slopeRating: 127,
    });
  });
});
