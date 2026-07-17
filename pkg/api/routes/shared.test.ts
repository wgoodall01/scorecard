import { env } from "cloudflare:test";
import { Hono } from "hono";
import { Jwt } from "hono/utils/jwt";
import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { createToken, requireAuth } from "./shared";

function buildApp() {
  return new Hono<Env>().get("/protected", requireAuth, (c) =>
    c.json({ email: c.get("authEmail") }),
  );
}

describe("requireAuth", () => {
  it("allows a valid token and normalizes the email", async () => {
    const token = await createToken("Foo@Example.com", env.JWT_SECRET);
    const res = await buildApp().request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "foo@example.com" });
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
    const token = await createToken("foo@example.com", "wrong-secret");
    const res = await buildApp().request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const token = await Jwt.sign(
      { email: "foo@example.com", exp: Math.floor(Date.now() / 1000) - 60 },
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

  it("rejects a token with an invalid email claim", async () => {
    const token = await Jwt.sign(
      { email: "not-an-email", exp: Math.floor(Date.now() / 1000) + 60 },
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
