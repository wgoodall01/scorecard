import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import worker from "../index";
import { signChallenge } from "../src/auth/webauthn";
import { createAuthRoutes, type AuthDeps } from "./auth";
import { createToken } from "./shared";

const ORIGIN = "http://localhost:5173";

// Stub the ceremony crypto so tests exercise the route logic (DB writes, invite
// consumption, token minting) without a real authenticator. Registration echoes
// the submitted response id as the new credential id.
const stubDeps: AuthDeps = {
  verifyRegistration: (async (opts: { response: { id: string } }) => ({
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "aaguid-test",
      credential: {
        id: opts.response.id,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
      },
      credentialType: "public-key",
      credentialDeviceType: "singleDevice",
      credentialBackedUp: true,
    },
  })) as unknown as AuthDeps["verifyRegistration"],
  verifyAuthentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 7 },
  })) as unknown as AuthDeps["verifyAuthentication"],
};

const app = new Hono<Env>().route("/", createAuthRoutes(stubDeps));

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

const now = () => new Date().toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

async function seedUser(id: string, email: string | null, name: string) {
  await env.DB.prepare(
    `INSERT INTO user (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, email, name, now(), now())
    .run();
}

async function seedInvite(userId: string, token: string, expiresAt: string) {
  await env.DB.prepare(
    `INSERT INTO invite (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(`inv-${token}`, userId, token, expiresAt, now(), now())
    .run();
}

async function seedCredential(id: string, userId: string, name: string) {
  await env.DB.prepare(
    `INSERT INTO credential (id, user_id, name, public_key, counter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, name, "AQID", 0, now(), now())
    .run();
}

beforeEach(async () => {
  await env.DB.batch(
    ["credential", "invite", "nickname", "user"].map((table) =>
      env.DB.prepare(`DELETE FROM "${table}"`),
    ),
  );
});

describe("passkey sign-in", () => {
  it("issues options and a challenge token", async () => {
    const res = await post("/auth/passkey/options", {}, { Origin: ORIGIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challengeToken: string; options: { challenge: string } };
    expect(typeof body.challengeToken).toBe("string");
    expect(typeof body.options.challenge).toBe("string");
  });

  it("rejects an unrecognized origin", async () => {
    const res = await post("/auth/passkey/options", {}, { Origin: "https://evil.example" });
    expect(res.status).toBe(400);
  });

  it("verifies an assertion, updates the counter, and mints a session token", async () => {
    await seedUser("alice", "alice@example.com", "Alice");
    await seedCredential("cred-1", "alice", "Laptop");

    const optionsRes = await post("/auth/passkey/options", {}, { Origin: ORIGIN });
    const { challengeToken } = (await optionsRes.json()) as { challengeToken: string };

    const res = await post(
      "/auth/passkey/verify",
      { challengeToken, response: { id: "cred-1" } },
      { Origin: ORIGIN },
    );
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { token: string }).token).toBe("string");

    const row = await env.DB.prepare(`SELECT counter, last_used_at FROM credential WHERE id = ?`)
      .bind("cred-1")
      .first<{ counter: number; last_used_at: string | null }>();
    expect(row?.counter).toBe(7);
    expect(row?.last_used_at).not.toBeNull();
  });

  it("rejects an unknown passkey", async () => {
    const optionsRes = await post("/auth/passkey/options", {}, { Origin: ORIGIN });
    const { challengeToken } = (await optionsRes.json()) as { challengeToken: string };
    const res = await post(
      "/auth/passkey/verify",
      { challengeToken, response: { id: "nope" } },
      { Origin: ORIGIN },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a tampered challenge token", async () => {
    await seedUser("alice", "alice@example.com", "Alice");
    await seedCredential("cred-1", "alice", "Laptop");
    const res = await post(
      "/auth/passkey/verify",
      { challengeToken: "not-a-real-token", response: { id: "cred-1" } },
      { Origin: ORIGIN },
    );
    expect(res.status).toBe(400);
  });
});

describe("passkey enrollment", () => {
  it("enrolls via an invite, stores the credential, and consumes the invite", async () => {
    await seedUser("bob", "bob@example.com", "Bob");
    await seedInvite("bob", "invite-tok", future());

    const optionsRes = await post(
      "/auth/register/options",
      { inviteToken: "invite-tok" },
      { Origin: ORIGIN },
    );
    expect(optionsRes.status).toBe(200);
    const { challengeToken } = (await optionsRes.json()) as { challengeToken: string };

    const res = await post(
      "/auth/register/verify",
      { challengeToken, response: { id: "bob-cred" }, name: "Bob's Phone" },
      { Origin: ORIGIN },
    );
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { token: string }).token).toBe("string");

    const cred = await env.DB.prepare(`SELECT user_id, name FROM credential WHERE id = ?`)
      .bind("bob-cred")
      .first<{ user_id: string; name: string }>();
    expect(cred).toEqual({ user_id: "bob", name: "Bob's Phone" });

    const invite = await env.DB.prepare(`SELECT token FROM invite WHERE token = ?`)
      .bind("invite-tok")
      .first();
    expect(invite).toBeNull();
  });

  it("rejects register options with an expired invite", async () => {
    await seedUser("bob", "bob@example.com", "Bob");
    await seedInvite("bob", "old-tok", past());
    const res = await post(
      "/auth/register/options",
      { inviteToken: "old-tok" },
      { Origin: ORIGIN },
    );
    expect(res.status).toBe(400);
  });

  it("rejects register options with neither invite nor session", async () => {
    const res = await post("/auth/register/options", {}, { Origin: ORIGIN });
    expect(res.status).toBe(401);
  });

  it("allows an in-session user to enroll another passkey", async () => {
    await seedUser("carol", "carol@example.com", "Carol");
    const token = await createToken("carol", env.JWT_SECRET);
    const optionsRes = await post(
      "/auth/register/options",
      {},
      { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    );
    expect(optionsRes.status).toBe(200);
    const { challengeToken } = (await optionsRes.json()) as { challengeToken: string };
    const res = await post(
      "/auth/register/verify",
      { challengeToken, response: { id: "carol-2" }, name: "Carol Desktop" },
      { Origin: ORIGIN },
    );
    expect(res.status).toBe(200);
    const cred = await env.DB.prepare(`SELECT user_id FROM credential WHERE id = ?`)
      .bind("carol-2")
      .first<{ user_id: string }>();
    expect(cred?.user_id).toBe("carol");
  });

  it("rejects register verify when the challenge token carries no user", async () => {
    const challengeToken = await signChallenge(env.AUTHN_CHALLENGE_SIGNING_SECRET, {
      challenge: "c",
      rpID: "localhost",
      origin: ORIGIN,
    });
    const res = await post(
      "/auth/register/verify",
      { challengeToken, response: { id: "x" } },
      { Origin: ORIGIN },
    );
    expect(res.status).toBe(400);
  });
});

describe("recovery & invites", () => {
  it("creates an invite and returns ok for a known email", async () => {
    await seedUser("dave", "dave@example.com", "Dave");
    const res = await post("/auth/recover", { email: "dave@example.com" });
    expect(res.status).toBe(200);

    const invite = await env.DB.prepare(`SELECT user_id FROM invite WHERE user_id = ?`)
      .bind("dave")
      .first<{ user_id: string }>();
    expect(invite?.user_id).toBe("dave");
  });

  it("returns ok without creating an invite for an unknown email (anti-enumeration)", async () => {
    const res = await post("/auth/recover", { email: "nobody@example.com" });
    expect(res.status).toBe(200);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM invite`).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("looks up an invite for the enroll page", async () => {
    await seedUser("erin", "erin@example.com", "Erin");
    await seedInvite("erin", "look-tok", future());
    const res = await app.request("/auth/invite/look-tok", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invite: { name: "Erin", email: "erin@example.com" } });
  });

  it("returns 410 for an expired invite and 404 for an unknown one", async () => {
    await seedUser("erin", "erin@example.com", "Erin");
    await seedInvite("erin", "gone-tok", past());
    expect((await app.request("/auth/invite/gone-tok", {}, env)).status).toBe(410);
    expect((await app.request("/auth/invite/missing", {}, env)).status).toBe(404);
  });
});

describe("credential management", () => {
  async function authHeaders(userId: string) {
    return { Authorization: `Bearer ${await createToken(userId, env.JWT_SECRET)}` };
  }

  it("lists, renames, and removes the caller's own passkeys", async () => {
    await seedUser("frank", "frank@example.com", "Frank");
    await seedCredential("f-1", "frank", "Phone");
    const headers = await authHeaders("frank");

    const listRes = await app.request("/auth/credentials", { headers }, env);
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as { credentials: unknown[] }).credentials).toHaveLength(1);

    const patchRes = await app.request(
      "/auth/credentials/f-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ name: "Frank's Phone" }),
      },
      env,
    );
    expect(patchRes.status).toBe(200);

    const delRes = await app.request("/auth/credentials/f-1", { method: "DELETE", headers }, env);
    expect(delRes.status).toBe(200);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM credential`).first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("scheduled cleanup deletes only expired invites", async () => {
    await seedUser("hank", "hank@example.com", "Hank");
    await seedInvite("hank", "fresh", future());
    await seedInvite("hank", "stale", past());

    const controller = {
      scheduledTime: Date.now(),
      cron: "0 0 * * 0",
      noRetry() {},
    } as unknown as ScheduledController;
    await worker.scheduled?.(controller, env);

    const remaining = await env.DB.prepare(`SELECT token FROM invite ORDER BY token`).all<{
      token: string;
    }>();
    expect(remaining.results.map((row) => row.token)).toEqual(["fresh"]);
  });

  it("won't rename or delete another user's passkey", async () => {
    await seedUser("frank", "frank@example.com", "Frank");
    await seedUser("gina", "gina@example.com", "Gina");
    await seedCredential("f-1", "frank", "Phone");
    const headers = await authHeaders("gina");

    const patchRes = await app.request(
      "/auth/credentials/f-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ name: "Hijacked" }),
      },
      env,
    );
    expect(patchRes.status).toBe(404);

    const delRes = await app.request("/auth/credentials/f-1", { method: "DELETE", headers }, env);
    expect(delRes.status).toBe(404);
  });
});
