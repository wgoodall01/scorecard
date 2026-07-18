import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { computeHonors, type Honor, type HonorSlug } from "./honors";

// The pool's D1 storage persists across tests in this file; start each test
// from empty tables (delete order respects foreign keys).
beforeEach(async () => {
  await env.DB.batch(
    [
      "score",
      "score_set",
      "outing",
      "hole",
      "course_set_tee",
      "course_set",
      "course",
      "nickname",
      "user",
    ].map((table) => env.DB.prepare(`DELETE FROM "${table}"`)),
  );
});

// Fixture course: 18 par-4 holes; 1–9 on set "front" (White, one standard
// tee), 10–18 on set "back" (Blue, likewise). Rounds are seeded as per-hole
// deltas from par, front first.
async function seedBase() {
  const holeValues = Array.from({ length: 18 }, (_, index) => {
    const number = index + 1;
    return `('h${number}', '${number <= 9 ? "front-t" : "back-t"}', ${number}, 4)`;
  }).join(", ");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO course (id, name) VALUES ('course', 'Buck Hill Falls')`),
    env.DB.prepare(
      `INSERT INTO course_set (id, course_id, name)
       VALUES ('front', 'course', 'White'), ('back', 'course', 'Blue')`,
    ),
    env.DB.prepare(
      `INSERT INTO course_set_tee (id, course_set_id, name, type)
       VALUES ('front-t', 'front', 'White', 'standard'), ('back-t', 'back', 'White', 'standard')`,
    ),
    env.DB.prepare(`INSERT INTO hole (id, course_set_tee_id, number, par) VALUES ${holeValues}`),
    env.DB.prepare(
      `INSERT INTO user (id, name) VALUES ('alice', 'Alice'), ('bob', 'Bob'), ('carol', 'Carol')`,
    ),
  ]);
}

async function seedRound(outingId: string, date: string, playerId: string, deltas: number[]) {
  const tees = [...new Set(deltas.map((_, index) => (index < 9 ? "front-t" : "back-t")))];
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO outing (id, date, course_id) VALUES (?, ?, 'course')`,
    ).bind(outingId, date),
    ...tees.map((teeId) =>
      env.DB.prepare(
        `INSERT INTO score_set (id, outing_id, player_id, course_set_tee_id) VALUES (?, ?, ?, ?)`,
      ).bind(`${outingId}:${playerId}:${teeId}`, outingId, playerId, teeId),
    ),
    ...deltas.map((delta, index) =>
      env.DB.prepare(
        `INSERT INTO score (id, score_set_id, hole_id, score) VALUES (?, ?, ?, ?)`,
      ).bind(
        `${outingId}:${playerId}:${index + 1}`,
        `${outingId}:${playerId}:${index < 9 ? "front-t" : "back-t"}`,
        `h${index + 1}`,
        4 + delta,
      ),
    ),
  ];
  await env.DB.batch(statements);
}

function board() {
  return computeHonors(env.DB, "2000-01-01");
}

function honor<TSlug extends HonorSlug>(honors: Honor[], slug: TSlug) {
  return honors.find((entry): entry is Extract<Honor, { slug: TSlug }> => entry.slug === slug);
}

const flat = Array.from({ length: 18 }, () => 0);

describe("computeHonors", () => {
  it("returns no honors for an empty window", async () => {
    await seedBase();
    expect(await board()).toEqual([]);
  });

  it("awards the medalist to the lowest 18-hole round vs par", async () => {
    await seedBase();
    await seedRound(
      "o1",
      "2026-07-01",
      "alice",
      [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    await seedRound(
      "o1",
      "2026-07-01",
      "bob",
      [2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    const medalist = honor(await board(), "medalist");
    expect(medalist?.holder.id).toBe("alice");
    expect(medalist?.toPar).toBe(3);
    expect(medalist?.strokes).toBe(75);
    expect(medalist?.holes).toBe(18);
    expect(medalist?.outing).toEqual({
      id: "o1",
      date: "2026-07-01",
      courseName: "Buck Hill Falls",
    });
  });

  it("does not award the medalist for a nine-hole round", async () => {
    await seedBase();
    await seedRound("o1", "2026-07-01", "alice", flat.slice(0, 9));
    const honors = await board();
    expect(honor(honors, "medalist")).toBeUndefined();
    // ...but the hot nine is still up for grabs.
    expect(honor(honors, "hot-nine")?.holder.id).toBe("alice");
  });

  it("breaks medalist ties in favor of the most recent round", async () => {
    await seedBase();
    await seedRound("o1", "2026-07-01", "alice", flat);
    await seedRound("o2", "2026-07-08", "bob", flat);
    expect(honor(await board(), "medalist")?.holder.id).toBe("bob");
  });

  it("awards the hot nine for the best complete single nine", async () => {
    await seedBase();
    // Alice: front nine +1, back nine -2 (the hot one).
    await seedRound(
      "o1",
      "2026-07-01",
      "alice",
      [1, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 0, 0],
    );
    await seedRound("o1", "2026-07-01", "bob", flat);
    const hotNine = honor(await board(), "hot-nine");
    expect(hotNine?.holder.id).toBe("alice");
    expect(hotNine?.nineName).toBe("Blue");
    expect(hotNine?.toPar).toBe(-2);
    expect(hotNine?.strokes).toBe(34);
  });

  it("counts birdies across the window for the birdie machine", async () => {
    await seedBase();
    await seedRound(
      "o1",
      "2026-07-01",
      "alice",
      [-1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    await seedRound(
      "o1",
      "2026-07-01",
      "bob",
      [-1, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    await seedRound(
      "o2",
      "2026-07-08",
      "alice",
      [-1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    const birdieMachine = honor(await board(), "birdie-machine");
    expect(birdieMachine?.holder.id).toBe("alice");
    expect(birdieMachine?.birdies).toBe(3);
    expect(birdieMachine?.latest.id).toBe("o2");
  });

  it("rates par-or-better share and consistency over at least 18 holes", async () => {
    await seedBase();
    await seedRound(
      "o1",
      "2026-07-01",
      "alice",
      [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    // Bob: fewer pars, wildly streaky.
    await seedRound(
      "o1",
      "2026-07-01",
      "bob",
      [4, 4, 4, 4, 0, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 0, 0],
    );
    // Nine holes only — below the 18-hole floor for rate honors.
    await seedRound("o1", "2026-07-01", "carol", flat.slice(0, 9));
    const honors = await board();
    const parMachine = honor(honors, "par-machine");
    expect(parMachine?.holder.id).toBe("alice");
    expect(parMachine?.pars).toBe(16);
    expect(parMachine?.holes).toBe(18);
    const metronome = honor(honors, "metronome");
    expect(metronome?.holder.id).toBe("alice");
    expect(metronome?.holes).toBe(18);
  });

  it("gives the iron golfer to whoever played the most outings", async () => {
    await seedBase();
    await seedRound("o1", "2026-07-01", "alice", flat);
    await seedRound("o1", "2026-07-01", "bob", flat);
    await seedRound("o2", "2026-07-08", "alice", flat);
    const ironGolfer = honor(await board(), "iron-golfer");
    expect(ironGolfer?.holder.id).toBe("alice");
    expect(ironGolfer?.outings).toBe(2);
    expect(ironGolfer?.latest.id).toBe("o2");
  });

  it("finds the comeback kid from a front-to-back swing", async () => {
    await seedBase();
    // Alice: +6 front, +1 back — a five-shot turnaround.
    await seedRound(
      "o1",
      "2026-07-01",
      "alice",
      [1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    // Bob got worse; no comeback for him.
    await seedRound(
      "o1",
      "2026-07-01",
      "bob",
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0],
    );
    const comebackKid = honor(await board(), "comeback-kid");
    expect(comebackKid?.holder.id).toBe("alice");
    expect(comebackKid?.frontToPar).toBe(6);
    expect(comebackKid?.backToPar).toBe(1);
    expect(comebackKid?.swing).toBe(5);
  });

  it("marks the crater at triple bogey or worse, but not double", async () => {
    await seedBase();
    await seedRound(
      "o1",
      "2026-07-01",
      "alice",
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    expect(honor(await board(), "crater")).toBeUndefined();

    await seedRound(
      "o2",
      "2026-07-02",
      "alice",
      [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    await seedRound(
      "o2",
      "2026-07-02",
      "bob",
      [0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    const crater = honor(await board(), "crater");
    expect(crater?.holder.id).toBe("bob");
    expect(crater?.holeNumber).toBe(5);
    expect(crater?.nineName).toBe("White");
    expect(crater?.strokes).toBe(9);
    expect(crater?.overPar).toBe(5);
  });

  it("collects snowmen at 8 strokes and up", async () => {
    await seedBase();
    await seedRound(
      "o1",
      "2026-07-01",
      "alice",
      [4, 4, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    await seedRound(
      "o1",
      "2026-07-01",
      "bob",
      [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    const snowman = honor(await board(), "snowman");
    expect(snowman?.holder.id).toBe("alice");
    expect(snowman?.count).toBe(3);
    expect(snowman?.worst).toBe(9);
  });

  it("only hands out the anchor when at least two players qualify", async () => {
    await seedBase();
    await seedRound("o1", "2026-07-01", "alice", flat);
    expect(honor(await board(), "anchor")).toBeUndefined();

    await seedRound(
      "o1",
      "2026-07-01",
      "bob",
      Array.from({ length: 18 }, () => 1),
    );
    const anchor = honor(await board(), "anchor");
    expect(anchor?.holder.id).toBe("bob");
    expect(anchor?.avgOverPar).toBe(1);
    expect(anchor?.holes).toBe(18);
  });

  it("ignores scores from outings before the window", async () => {
    await seedBase();
    await seedRound("o1", "2026-07-01", "alice", flat);
    const honors = await computeHonors(env.DB, "2026-07-02");
    expect(honors).toEqual([]);
  });
});
