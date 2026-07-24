import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import { outingRoutes } from "./outings";
import { createToken } from "./shared";

const app = new Hono<Env>().route("/", outingRoutes);

// The pool's D1 storage persists across tests; start each test from empty
// tables (delete order respects foreign keys). Fixture: one set ("White")
// with two tees — tw (White markers, holes w1/w2 = numbers 1/2) and tb
// (Blue markers, holes b1/b2 = the same numbers).
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
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO course (id, name) VALUES ('course', 'Buck Hill Falls')`),
    env.DB.prepare(
      `INSERT INTO course_set (id, course_id, name) VALUES ('front', 'course', 'White'), ('back', 'course', 'Red')`,
    ),
    env.DB.prepare(
      `INSERT INTO course_set_tee (id, course_set_id, name, type) VALUES ('tw', 'front', 'White', 'standard'), ('tb', 'front', 'Blue', 'back'), ('tr', 'back', 'Red', 'standard')`,
    ),
    env.DB.prepare(
      `INSERT INTO hole (id, course_set_tee_id, number, par)
       VALUES ('w1', 'tw', 1, 4), ('w2', 'tw', 2, 4), ('b1', 'tb', 1, 4), ('b2', 'tb', 2, 4),
              ('r1', 'tr', 10, 4)`,
    ),
    env.DB.prepare(
      `INSERT INTO user (id, name) VALUES ('alice', 'Alice'), ('bob', 'Bob'), ('dave', 'Dave')`,
    ),
  ]);
});

const TEE_BY_HOLE: Record<string, string> = {
  w1: "tw",
  w2: "tw",
  b1: "tb",
  b2: "tb",
  r1: "tr",
};

async function seedOuting(
  id: string,
  date: string,
  players: { playerId: string; scores: Record<string, number> }[],
) {
  const scoreSets = new Set(
    players.flatMap((player) =>
      Object.keys(player.scores).map((holeId) => `${player.playerId}/${TEE_BY_HOLE[holeId]}`),
    ),
  );
  const statements = [
    env.DB.prepare(`INSERT INTO outing (id, date, course_id) VALUES (?, ?, 'course')`).bind(
      id,
      date,
    ),
    ...[...scoreSets].map((key) => {
      const [playerId, teeId] = key.split("/");
      return env.DB.prepare(
        `INSERT INTO score_set (id, outing_id, player_id, course_set_tee_id) VALUES (?, ?, ?, ?)`,
      ).bind(`${id}:${playerId}:${teeId}`, id, playerId, teeId);
    }),
    ...players.flatMap((player) =>
      Object.entries(player.scores).map(([holeId, strokes]) =>
        env.DB.prepare(
          `INSERT INTO score (id, score_set_id, hole_id, score) VALUES (?, ?, ?, ?)`,
        ).bind(
          `${id}:${player.playerId}:${holeId}`,
          `${id}:${player.playerId}:${TEE_BY_HOLE[holeId]}`,
          holeId,
          strokes,
        ),
      ),
    ),
  ];
  await env.DB.batch(statements);
}

async function mergeOutings(targetId: string, sourceId: string) {
  const token = await createToken("alice@example.com", env.JWT_SECRET);
  return app.request(
    `/outings/${targetId}/merge`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ outingId: sourceId }),
    },
    env,
  );
}

async function submitOuting(date: string) {
  const token = await createToken("alice@example.com", env.JWT_SECRET);
  return app.request(
    "/outings",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        scorecardId: null,
        outingId: null,
        courseId: "course",
        nines: [
          {
            courseSetId: "front",
            players: [
              { playerId: "alice", courseSetTeeId: "tw", scores: [{ holeNumber: 1, score: 4 }] },
            ],
          },
        ],
      }),
    },
    env,
  );
}

async function listOutings(query: Record<string, string> = {}) {
  const token = await createToken("alice@example.com", env.JWT_SECRET);
  const search = new URLSearchParams(query).toString();
  const res = await app.request(
    `/outings${search ? `?${search}` : ""}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
  return {
    status: res.status,
    body: (await res.json()) as { records: { id: string }[]; next: string | null },
  };
}

describe("GET /outings", () => {
  // Newest recorded first: ids are uuidv7 in production, and these sort the
  // same way.
  beforeEach(async () => {
    await seedOuting("o1", "2026-07-01", [{ playerId: "alice", scores: { w1: 4 } }]);
    await seedOuting("o2", "2026-07-02", [{ playerId: "bob", scores: { b1: 5 } }]);
    await seedOuting("o3", "2026-07-03", [{ playerId: "alice", scores: { r1: 6 } }]);
  });

  it("lists newest first, in one page when it fits", async () => {
    const { body } = await listOutings();
    expect(body.records.map((entry) => entry.id)).toEqual(["o3", "o2", "o1"]);
    expect(body.next).toBeNull();
  });

  it("walks the cursor without repeating or dropping an outing", async () => {
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const { body } = await listOutings({ limit: "2", ...(after ? { after } : {}) });
      seen.push(...body.records.map((entry) => entry.id));
      after = body.next;
    } while (after);
    expect(seen).toEqual(["o3", "o2", "o1"]);
  });

  it("rejects a cursor it didn't mint", async () => {
    expect((await listOutings({ after: "bogus" })).status).toBe(400);
  });

  // The filters have to run in SQL: applied to the page after LIMIT they'd
  // hand back short pages while the cursor marched past the matches.
  it("filters by player in SQL, so a paged filter still fills the page", async () => {
    const { body } = await listOutings({ playerId: "alice", limit: "1" });
    expect(body.records.map((entry) => entry.id)).toEqual(["o3"]);
    const { body: rest } = await listOutings({ playerId: "alice", after: body.next! });
    expect(rest.records.map((entry) => entry.id)).toEqual(["o1"]);
    expect(rest.next).toBeNull();
  });

  it("filters by nine", async () => {
    const { body } = await listOutings({ courseSetId: "back" });
    expect(body.records.map((entry) => entry.id)).toEqual(["o3"]);
  });

  it("filters by date, for the same-day merge lookup", async () => {
    const { body } = await listOutings({ date: "2026-07-02", courseId: "course" });
    expect(body.records.map((entry) => entry.id)).toEqual(["o2"]);
  });
});

describe("POST /outings", () => {
  it("rejects a future-dated outing", async () => {
    const res = await submitOuting("2999-01-01");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The outing date is in the future" });
  });

  it("accepts an outing dated today", async () => {
    const res = await submitOuting(new Date().toISOString().slice(0, 10));
    expect(res.status).toBe(201);
  });

  it("accepts an outing dated in the past", async () => {
    const res = await submitOuting("2026-07-01");
    expect(res.status).toBe(201);
  });
});

describe("POST /outings/:id/merge", () => {
  it("moves rows to the target, keeps the target's cells on conflict, deletes the source", async () => {
    // alice: same tee on both — hole 1 conflicts (target wins), hole 2 pours
    // into the target's existing score set. bob: only on the source — his
    // score set moves wholesale. dave: DIFFERENT tees on the two outings
    // but the same nine and hole number — the target's cell wins and his
    // emptied source score set is dropped.
    await seedOuting("o1", "2026-07-01", [
      { playerId: "alice", scores: { w1: 4 } },
      { playerId: "dave", scores: { w1: 5 } },
    ]);
    await seedOuting("o2", "2026-07-01", [
      { playerId: "alice", scores: { w1: 7, w2: 5 } },
      { playerId: "bob", scores: { b1: 6 } },
      { playerId: "dave", scores: { b1: 8 } },
    ]);

    const res = await mergeOutings("o1", "o2");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outingId: "o1" });

    const { results: scores } = await env.DB.prepare(
      `SELECT ss.outing_id, ss.player_id, ss.course_set_tee_id AS tee, s.hole_id, s.score
       FROM score s JOIN score_set ss ON ss.id = s.score_set_id
       ORDER BY ss.player_id, s.hole_id`,
    ).all();
    expect(scores).toEqual([
      { outing_id: "o1", player_id: "alice", tee: "tw", hole_id: "w1", score: 4 },
      { outing_id: "o1", player_id: "alice", tee: "tw", hole_id: "w2", score: 5 },
      { outing_id: "o1", player_id: "bob", tee: "tb", hole_id: "b1", score: 6 },
      { outing_id: "o1", player_id: "dave", tee: "tw", hole_id: "w1", score: 5 },
    ]);

    // Exactly one score set per surviving (player, tee) — alice's source set
    // was folded into the target's, and dave's emptied source set is gone.
    const { results: scoreSets } = await env.DB.prepare(
      `SELECT outing_id, player_id, course_set_tee_id AS tee FROM score_set ORDER BY player_id`,
    ).all();
    expect(scoreSets).toEqual([
      { outing_id: "o1", player_id: "alice", tee: "tw" },
      { outing_id: "o1", player_id: "bob", tee: "tb" },
      { outing_id: "o1", player_id: "dave", tee: "tw" },
    ]);

    const { results: outings } = await env.DB.prepare(`SELECT id FROM outing`).all();
    expect(outings).toEqual([{ id: "o1" }]);
  });

  it("rejects merging outings on different dates", async () => {
    await seedOuting("o1", "2026-07-01", [{ playerId: "alice", scores: { w1: 4 } }]);
    await seedOuting("o2", "2026-07-02", [{ playerId: "bob", scores: { w1: 6 } }]);
    const res = await mergeOutings("o1", "o2");
    expect(res.status).toBe(400);
  });

  it("rejects merging an outing into itself", async () => {
    await seedOuting("o1", "2026-07-01", [{ playerId: "alice", scores: { w1: 4 } }]);
    const res = await mergeOutings("o1", "o1");
    expect(res.status).toBe(400);
  });
});
