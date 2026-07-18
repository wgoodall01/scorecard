import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { computeHandicap, handicapFromRounds } from "./handicap";

// Pure-engine fixtures: two par-36 nines rated CR 36.0 / Slope 113 make the
// math transparent — an 18-hole differential is exactly AGS − 72 and a
// 9-hole one AGS − 36, so every expectation below is hand-checkable.

function nine(setId: string, firstHole: number, strokes: number[]) {
  return {
    setId,
    name: setId,
    par: strokes.length * 4,
    courseRating: strokes.length * 4,
    slopeRating: 113,
    holes: strokes.map((s, index) => ({ number: firstHole + index, par: 4, strokes: s })),
  };
}

// An 18-hole stroke line totalling `total` on 18 par 4s, spread evenly
// (extras land on the low-numbered holes first).
function strokesFor(total: number, holes = 18) {
  const extras = total - holes * 4;
  return Array.from({ length: holes }, (_, index) => {
    return 4 + Math.floor(extras / holes) + (index < extras % holes ? 1 : 0);
  });
}

function round18(outingId: string, date: string, total: number, holeOverrides?: number[]) {
  const strokes = holeOverrides ?? strokesFor(total);
  return {
    outingId,
    date,
    nines: [nine("front", 1, strokes.slice(0, 9)), nine("back", 10, strokes.slice(9))],
  };
}

function round9(outingId: string, date: string, total: number) {
  return { outingId, date, nines: [nine("front", 1, strokesFor(total, 9))] };
}

// Sequential dates so every test stays inside one Low-Index window.
function date(index: number) {
  const day = new Date(Date.UTC(2026, 0, 1 + index));
  return day.toISOString().slice(0, 10);
}

describe("handicapFromRounds", () => {
  it("returns no index for an empty record", () => {
    const result = handicapFromRounds([]);
    expect(result.index).toBeNull();
    expect(result.provisional).toBe(true);
    expect(result.timeseries).toEqual([]);
  });

  it("issues a provisional index from a single 18-hole round", () => {
    // 90 on a 72-rated course: differential 18.0; lowest 1 − 2.0 = 16.0.
    const result = handicapFromRounds([round18("o1", date(0), 90)]);
    expect(result.index).toBe(16.0);
    expect(result.provisional).toBe(true);
    expect(result.timeseries).toEqual([
      {
        outingId: "o1",
        date: date(0),
        setNames: ["front", "back"],
        strokes: 90,
        differential: 18.0,
        holes: 18,
        index: 16.0,
        provisional: true,
        counted: true,
      },
    ]);
  });

  it("becomes established (non-provisional) at three differentials", () => {
    const result = handicapFromRounds([
      round18("o1", date(0), 90),
      round18("o2", date(1), 92),
      round18("o3", date(2), 94),
    ]);
    expect(result.provisional).toBe(false);
    // n=3: lowest 1 (18.0) − 2.0.
    expect(result.index).toBe(16.0);
    expect(result.timeseries.map((point) => point.provisional)).toEqual([true, true, false]);
    // Only the low round is averaged into the current index.
    expect(result.timeseries.map((point) => point.counted)).toEqual([true, false, false]);
  });

  it("walks the fewer-than-20 selection table as the record grows", () => {
    // Five rounds of 92 (differential 20.0 each): n=1..3 → 18.0, n=4 → 19.0,
    // n=5 → 20.0.
    const rounds = Array.from({ length: 5 }, (_, index) => round18(`o${index}`, date(index), 92));
    const result = handicapFromRounds(rounds);
    expect(result.timeseries.map((point) => point.index)).toEqual([18.0, 18.0, 18.0, 19.0, 20.0]);
  });

  it("bootstraps a provisional index by doubling a first 9-hole differential", () => {
    // 45 on a 36-rated nine: 9-hole differential 9.0, doubled to 18.0.
    const result = handicapFromRounds([round9("o1", date(0), 45)]);
    expect(result.index).toBe(16.0);
    expect(result.timeseries[0]).toMatchObject({ differential: 18.0, holes: 9 });
  });

  it("uses the expected-differential method for a 9-hole score once an index exists", () => {
    // Round 1 establishes 16.0. Round 2's nine: differential 9.0 + expected
    // (0.52 × 16.0 + 1.2 = 9.52) = 18.52 → 18.5.
    const result = handicapFromRounds([round18("o1", date(0), 90), round9("o2", date(1), 45)]);
    expect(result.timeseries[1]).toMatchObject({ differential: 18.5, holes: 9 });
    // n=2: lowest of {18.0, 18.5} − 2.0.
    expect(result.index).toBe(16.0);
  });

  it("caps a blow-up hole at net double bogey", () => {
    // Round 1: 90 → index 16.0, so round 2 plays off course handicap 16 —
    // hole 1 receives a stroke and caps at 4 + 2 + 1 = 7. A 15 on hole 1
    // plus 17 fives adjusts 100 → 92, differential 20.0 (not 28.0).
    const result = handicapFromRounds([
      round18("o1", date(0), 90),
      round18("o2", date(1), 100, [15, ...Array.from({ length: 17 }, () => 5)]),
    ]);
    expect(result.timeseries[1].differential).toBe(20.0);
  });

  it("caps at par + 5 before any index exists", () => {
    // First-ever round: 15 on hole 1 caps at 4 + 5 = 9; 17 fours stand.
    // AGS 77 → differential 5.0 → index 3.0.
    const result = handicapFromRounds([
      round18("o1", date(0), 83, [15, ...Array.from({ length: 17 }, () => 4)]),
    ]);
    expect(result.timeseries[0].differential).toBe(5.0);
    expect(result.index).toBe(3.0);
  });

  it("applies an exceptional score reduction to the whole record", () => {
    // Five 92s hold the index at 20.0. An 82 (differential 10.0) is 10.0
    // better than the index in effect → −2.0 to all six stored
    // differentials: {18×5, 8}. n=6: avg of lowest 2 (8, 18) − 1.0 = 12.0.
    const rounds = Array.from({ length: 5 }, (_, index) => round18(`o${index}`, date(index), 92));
    rounds.push(round18("o5", date(5), 82));
    const result = handicapFromRounds(rounds);
    expect(result.timeseries[5]).toMatchObject({ differential: 10.0, index: 12.0 });
  });

  it("soft- and hard-caps rises against the Low Index once 20 scores exist", () => {
    // Twenty 82s (differential 10.0) settle the index and Low Index at 10.0.
    // Then 102s (differential 30.0) push the raw calculation up:
    // at 14 highs calc = 15.0 → soft cap 10 + 3 + 0.5×2 = 14.0;
    // at 15 highs calc = 17.5 → soft cap 15.3, hard cap 10 + 5 = 15.0.
    const rounds = Array.from({ length: 20 }, (_, index) =>
      round18(`low${index}`, date(index), 82),
    );
    for (let index = 0; index < 15; index++) {
      rounds.push(round18(`high${index}`, date(20 + index), 102));
    }
    const result = handicapFromRounds(rounds);
    const indexes = result.timeseries.map((point) => point.index);
    expect(indexes[19]).toBe(10.0);
    expect(indexes[33]).toBe(14.0);
    expect(indexes[34]).toBe(15.0);
    expect(result.index).toBe(15.0);
  });

  it("posts an 18-hole and a 9-hole differential from a 27-hole outing", () => {
    const outing = {
      outingId: "o1",
      date: date(0),
      nines: [
        nine("front", 1, strokesFor(45, 9)),
        nine("back", 10, strokesFor(45, 9)),
        nine("extra", 1, strokesFor(45, 9)),
      ],
    };
    const result = handicapFromRounds([outing]);
    expect(result.timeseries.map((point) => point.holes)).toEqual([18, 9]);
    expect(result.differentialCount).toBe(2);
    // Each round reports the nines it was assembled from and the gross
    // strokes on them — never the raw 27-hole outing total.
    expect(result.timeseries.map((point) => point.strokes)).toEqual([90, 45]);
    expect(result.timeseries.flatMap((point) => point.setNames)).toEqual([
      "front",
      "extra",
      "back",
    ]);
  });
});

// Integration: the SQL layer — grouping scored holes into rounds, dropping
// unrated and incomplete nines, and chronological ordering.

beforeEach(async () => {
  await env.DB.batch(
    [
      "score",
      "outing_player",
      "outing",
      "hole",
      "course_set_rating",
      "course_set",
      "course",
      "nickname",
      "user",
    ].map((table) => env.DB.prepare(`DELETE FROM "${table}"`)),
  );
});

async function seedBase() {
  const holeValues = Array.from({ length: 18 }, (_, index) => {
    const number = index + 1;
    return `('h${number}', '${number <= 9 ? "front" : "back"}', ${number}, 4)`;
  }).join(", ");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO course (id, name, ncrdb_facility_id) VALUES ('course', 'Buck Hill Falls', 20114)`,
    ),
    env.DB.prepare(
      `INSERT INTO course_set (id, course_id, name, disposition)
       VALUES ('front', 'course', 'White', 'front'),
              ('back', 'course', 'Blue', 'back'),
              ('unrated', 'course', 'Red', 'front')`,
    ),
    // Standard-tee ratings on both nines, plus a harder back-tee rating on
    // the front nine for the tee-resolution test. The Red set stays unrated.
    env.DB.prepare(
      `INSERT INTO course_set_rating (id, course_set_id, tee, course_rating, slope_rating)
       VALUES ('r1', 'front', 'standard', 36.0, 113),
              ('r2', 'back', 'standard', 36.0, 113),
              ('r3', 'front', 'back', 34.0, 120)`,
    ),
    env.DB.prepare(`INSERT INTO hole (id, course_set_id, number, par) VALUES ${holeValues}`),
    env.DB.prepare(
      `INSERT INTO hole (id, course_set_id, number, par)
       VALUES ${Array.from({ length: 9 }, (_, index) => `('u${index + 1}', 'unrated', ${index + 1}, 4)`).join(", ")}`,
    ),
    env.DB.prepare(`INSERT INTO user (id, name) VALUES ('alice', 'Alice')`),
  ]);
}

async function seedScores(outingId: string, date: string, cells: [string, number][]) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO outing (id, date, course_id) VALUES (?, ?, 'course')`,
    ).bind(outingId, date),
    ...cells.map(([holeId, strokes]) =>
      env.DB.prepare(
        `INSERT INTO score (id, outing_id, player_id, hole_id, score) VALUES (?, ?, 'alice', ?, ?)`,
      ).bind(`${outingId}:${holeId}`, outingId, holeId, strokes),
    ),
  ]);
}

const eighteenFives: [string, number][] = Array.from({ length: 18 }, (_, index) => [
  `h${index + 1}`,
  5,
]);

describe("computeHandicap", () => {
  it("computes an index from recorded scores", async () => {
    await seedBase();
    await seedScores("o1", "2026-07-01", eighteenFives);
    const result = await computeHandicap(env.DB, "alice");
    expect(result.index).toBe(16.0);
    expect(result.provisional).toBe(true);
    expect(result.asOf).toBe("2026-07-01");
    expect(result.timeseries).toHaveLength(1);
  });

  it("ignores unrated and incomplete nines", async () => {
    await seedBase();
    // A full nine on the unrated set and 8 holes on the front: neither can
    // post, but the complete back nine still does (differential 9.0 doubled).
    await seedScores("o1", "2026-07-01", [
      ...Array.from({ length: 9 }, (_, index): [string, number] => [`u${index + 1}`, 5]),
      ...Array.from({ length: 8 }, (_, index): [string, number] => [`h${index + 1}`, 5]),
      ...Array.from({ length: 9 }, (_, index): [string, number] => [`h${index + 10}`, 5]),
    ]);
    const result = await computeHandicap(env.DB, "alice");
    expect(result.differentialCount).toBe(1);
    expect(result.timeseries[0]).toMatchObject({
      holes: 9,
      differential: 18.0,
      setNames: ["Blue"],
      strokes: 45,
    });
  });

  it("replays outings in date order", async () => {
    await seedBase();
    // Inserted newest-first; the 94 (differential 22.0) must process first
    // for the 90 (18.0) to be the record's low.
    await seedScores("o2", "2026-07-08", eighteenFives);
    await seedScores(
      "o1",
      "2026-07-01",
      Array.from({ length: 18 }, (_, index): [string, number] => [
        `h${index + 1}`,
        index < 4 ? 6 : 5,
      ]),
    );
    const result = await computeHandicap(env.DB, "alice");
    expect(result.timeseries.map((point) => point.differential)).toEqual([22.0, 18.0]);
    expect(result.timeseries.map((point) => point.counted)).toEqual([false, true]);
  });

  it("returns an empty record for a player with no scores", async () => {
    await seedBase();
    const result = await computeHandicap(env.DB, "alice");
    expect(result.index).toBeNull();
    expect(result.timeseries).toEqual([]);
  });

  it("rates each round on the tee the player played, falling back to standard", async () => {
    await seedBase();
    const nineFives: [string, number][] = Array.from({ length: 9 }, (_, index) => [
      `h${index + 1}`,
      5,
    ]);
    // o1 from the back tees (34.0 / 120): 45 gives a 9-hole differential of
    // (113/120) x 11 = 10.358, doubled (first-ever score) -> 20.7.
    await seedScores("o1", "2026-07-01", nineFives);
    await env.DB.prepare(
      `INSERT INTO outing_player (id, outing_id, player_id, tee) VALUES ('op1', 'o1', 'alice', 'back')`,
    ).run();
    // o2 from the (unrated) junior tees: falls back to standard (36.0/113),
    // 9-hole differential 9.0 + expected (0.52 x 18.7 + 1.2) = 19.924 -> 19.9.
    await seedScores("o2", "2026-07-08", nineFives);
    await env.DB.prepare(
      `INSERT INTO outing_player (id, outing_id, player_id, tee) VALUES ('op2', 'o2', 'alice', 'junior')`,
    ).run();
    const result = await computeHandicap(env.DB, "alice");
    expect(result.timeseries.map((point) => point.differential)).toEqual([20.7, 19.9]);
  });

  it("uses the profile's preferred tee when the outing doesn't record one", async () => {
    await seedBase();
    await env.DB.prepare(`UPDATE user SET preferred_tee = 'back' WHERE id = 'alice'`).run();
    await seedScores(
      "o1",
      "2026-07-01",
      Array.from({ length: 9 }, (_, index): [string, number] => [`h${index + 1}`, 5]),
    );
    const result = await computeHandicap(env.DB, "alice");
    expect(result.timeseries[0].differential).toBe(20.7);
  });
});
