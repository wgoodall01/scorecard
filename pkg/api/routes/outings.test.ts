import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import { outingRoutes } from "./outings";
import { createToken } from "./shared";

const app = new Hono<Env>().route("/", outingRoutes);

// The pool's D1 storage persists across tests; start each test from empty
// tables (delete order respects foreign keys).
beforeEach(async () => {
  await env.DB.batch(
    ["score", "outing_player", "outing", "hole", "course_set", "course", "nickname", "user"].map(
      (table) => env.DB.prepare(`DELETE FROM "${table}"`),
    ),
  );
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO course (id, name) VALUES ('course', 'Buck Hill Falls')`),
    env.DB.prepare(
      `INSERT INTO course_set (id, course_id, name, disposition) VALUES ('front', 'course', 'White', 'front')`,
    ),
    env.DB.prepare(
      `INSERT INTO hole (id, course_set_id, number, par) VALUES ('h1', 'front', 1, 4), ('h2', 'front', 2, 4)`,
    ),
    env.DB.prepare(`INSERT INTO user (id, name) VALUES ('alice', 'Alice'), ('bob', 'Bob')`),
  ]);
});

async function seedOuting(
  id: string,
  date: string,
  players: { playerId: string; tee?: string; scores: Record<string, number> }[],
) {
  const statements = [
    env.DB.prepare(`INSERT INTO outing (id, date, course_id) VALUES (?, ?, 'course')`).bind(
      id,
      date,
    ),
    ...players.flatMap((player) => [
      env.DB.prepare(
        `INSERT INTO outing_player (id, outing_id, player_id, tee) VALUES (?, ?, ?, ?)`,
      ).bind(`${id}:${player.playerId}`, id, player.playerId, player.tee ?? null),
      ...Object.entries(player.scores).map(([holeId, strokes]) =>
        env.DB.prepare(
          `INSERT INTO score (id, outing_id, player_id, hole_id, score) VALUES (?, ?, ?, ?, ?)`,
        ).bind(`${id}:${player.playerId}:${holeId}`, id, player.playerId, holeId, strokes),
      ),
    ]),
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
        newCourse: null,
        nines: [
          {
            courseSetId: "front",
            newSet: null,
            players: [{ playerId: "alice", tee: null, scores: [{ holeNumber: 1, score: 4 }] }],
          },
        ],
      }),
    },
    env,
  );
}

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
    await seedOuting("o1", "2026-07-01", [{ playerId: "alice", tee: "back", scores: { h1: 4 } }]);
    await seedOuting("o2", "2026-07-01", [
      { playerId: "alice", tee: "front", scores: { h1: 7, h2: 5 } },
      { playerId: "bob", scores: { h1: 6 } },
    ]);

    const res = await mergeOutings("o1", "o2");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outingId: "o1" });

    const { results: scores } = await env.DB.prepare(
      `SELECT outing_id, player_id, hole_id, score FROM score ORDER BY player_id, hole_id`,
    ).all();
    expect(scores).toEqual([
      { outing_id: "o1", player_id: "alice", hole_id: "h1", score: 4 },
      { outing_id: "o1", player_id: "alice", hole_id: "h2", score: 5 },
      { outing_id: "o1", player_id: "bob", hole_id: "h1", score: 6 },
    ]);

    const { results: players } = await env.DB.prepare(
      `SELECT outing_id, player_id, tee FROM outing_player ORDER BY player_id`,
    ).all();
    expect(players).toEqual([
      { outing_id: "o1", player_id: "alice", tee: "back" },
      { outing_id: "o1", player_id: "bob", tee: null },
    ]);

    const { results: outings } = await env.DB.prepare(`SELECT id FROM outing`).all();
    expect(outings).toEqual([{ id: "o1" }]);
  });

  it("rejects merging outings on different dates", async () => {
    await seedOuting("o1", "2026-07-01", [{ playerId: "alice", scores: { h1: 4 } }]);
    await seedOuting("o2", "2026-07-02", [{ playerId: "bob", scores: { h1: 6 } }]);
    const res = await mergeOutings("o1", "o2");
    expect(res.status).toBe(400);
  });

  it("rejects merging an outing into itself", async () => {
    await seedOuting("o1", "2026-07-01", [{ playerId: "alice", scores: { h1: 4 } }]);
    const res = await mergeOutings("o1", "o1");
    expect(res.status).toBe(400);
  });
});
