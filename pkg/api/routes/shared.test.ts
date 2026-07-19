import { env } from "cloudflare:test";
import { Hono } from "hono";
import { Jwt } from "hono/utils/jwt";
import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { createToken, requireAuth } from "./shared";

function buildApp() {
  return new Hono<Env>().get("/protected", requireAuth, (c) =>
    c.json({ userId: c.get("authUserId") }),
  );
}

describe("requireAuth", () => {
  it("allows a valid token and exposes the user id", async () => {
    const token = await createToken("user-123", env.JWT_SECRET);
    const res = await buildApp().request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-123" });
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await buildApp().request("/protected", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await buildApp().request(
      "/protected",
      { headers: { Authorization: "not-a-bearer-token" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await createToken("user-123", "wrong-secret");
    const res = await buildApp().request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const token = await Jwt.sign(
      { sub: "user-123", exp: Math.floor(Date.now() / 1000) - 60 },
      env.JWT_SECRET,
      "HS256",
    );
    const res = await buildApp().request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a token with no subject", async () => {
    const token = await Jwt.sign(
      { exp: Math.floor(Date.now() / 1000) + 60 },
      env.JWT_SECRET,
      "HS256",
    );
    const res = await buildApp().request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(401);
  });
});
