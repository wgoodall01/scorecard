import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import { golferRoutes } from "./golfers";
import { createToken } from "./shared";

const app = new Hono<Env>().route("/", golferRoutes);

// The pool's D1 storage persists across tests; start from empty tables. Ids
// stand in for uuidv7s — they sort the same way, newest last.
beforeEach(async () => {
  await env.DB.batch(["nickname", "user"].map((table) => env.DB.prepare(`DELETE FROM "${table}"`)));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email) VALUES
         ('u1', 'Alice Ackerman', 'alice@example.com'),
         ('u2', 'Bob Bernard', 'bob@example.com'),
         ('u3', 'Carol Chen', NULL)`,
    ),
    env.DB.prepare(
      `INSERT INTO nickname (id, user_id, nickname, nickname_type)
       VALUES ('n1', 'u3', 'Slice', 'nickname')`,
    ),
  ]);
});

async function listGolfers(query: Record<string, string> = {}) {
  const token = await createToken("u1", env.JWT_SECRET);
  const search = new URLSearchParams(query).toString();
  const res = await app.request(
    `/golfers${search ? `?${search}` : ""}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
  return {
    status: res.status,
    body: (await res.json()) as { records: { id: string }[]; next: string | null },
  };
}

describe("GET /golfers", () => {
  it("lists newest first and pages through the cursor", async () => {
    const { body: first } = await listGolfers({ limit: "2" });
    expect(first.records.map((golfer) => golfer.id)).toEqual(["u3", "u2"]);
    expect(first.next).not.toBeNull();

    const { body: second } = await listGolfers({ limit: "2", after: first.next! });
    expect(second.records.map((golfer) => golfer.id)).toEqual(["u1"]);
    expect(second.next).toBeNull();
  });

  // Search runs in SQL so it spans every page, not just the loaded one.
  it("searches name, email, and nicknames case-insensitively", async () => {
    expect((await listGolfers({ q: "acker" })).body.records.map((golfer) => golfer.id)).toEqual([
      "u1",
    ]);
    expect((await listGolfers({ q: "BOB@EXAMPLE" })).body.records.map((g) => g.id)).toEqual(["u2"]);
    // Carol has no email — matching on her nickname must not need one.
    expect((await listGolfers({ q: "slice" })).body.records.map((g) => g.id)).toEqual(["u3"]);
    expect((await listGolfers({ q: "nobody" })).body.records).toEqual([]);
  });

  it("pages a filtered list", async () => {
    const { body } = await listGolfers({ q: "e", limit: "1" });
    expect(body.records).toHaveLength(1);
    expect(body.next).not.toBeNull();
  });

  it("rejects a cursor it didn't mint", async () => {
    expect((await listGolfers({ after: "bogus" })).status).toBe(400);
  });
});
