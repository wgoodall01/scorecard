import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { credential, invite, user } from "../schema";
import { enrollEmail } from "../src/email/templates/enroll_link";
import {
  decodePublicKey,
  encodePublicKey,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  randomToken,
  resolveRp,
  signChallenge,
  verifyAuthenticationResponse,
  verifyChallenge,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "../src/auth/webauthn";
import {
  createToken,
  Email,
  getCurrentUser,
  getRequestUserId,
  requireAuth,
  zodBody,
} from "./shared";

// Recovery / add-a-device links are sensitive and acted on immediately, so a
// short window. (Admin invites onboard a new account and use a longer window —
// see routes/golfers.ts.)
const RECOVERY_TTL_SECONDS = 60 * 60;

// The verify functions are injected so tests can stub the ceremony crypto.
export type AuthDeps = {
  verifyRegistration: typeof verifyRegistrationResponse;
  verifyAuthentication: typeof verifyAuthenticationResponse;
};
const defaultDeps: AuthDeps = {
  verifyRegistration: verifyRegistrationResponse,
  verifyAuthentication: verifyAuthenticationResponse,
};

// A WebAuthn ceremony response is a large browser-produced object; validate the
// wrapper and the one field we key on, and pass the rest through untouched.
const CeremonyResponse = z.looseObject({ id: z.string() });

const PasskeyVerifyRequest = z.object({
  challengeToken: z.string().min(1),
  response: CeremonyResponse,
});

const RegisterOptionsRequest = z.object({ inviteToken: z.string().optional() });

const RegisterVerifyRequest = z.object({
  challengeToken: z.string().min(1),
  response: CeremonyResponse,
  name: z.string().trim().min(1).max(60).optional(),
});

const RecoverRequest = z.object({ email: Email });

const RenameCredentialRequest = z.object({ name: z.string().trim().min(1).max(60) });

function nowIso() {
  return new Date().toISOString();
}

function enrollLink(requestUrl: string, token: string) {
  const url = new URL("/enroll", requestUrl);
  url.searchParams.set("token", token);
  return url;
}

async function createInvite(db: ReturnType<typeof getDb>, userId: string, ttlSeconds: number) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await db.insert(invite).values({ userId, token, expiresAt });
  return { token, expiresAt };
}

export function createAuthRoutes(deps: AuthDeps = defaultDeps) {
  return (
    new Hono<Env>()
      // --- Sign-in (usernameless / discoverable) -----------------------------
      .post("/auth/passkey/options", async (c) => {
        const rp = resolveRp(c.env, c.req.header("Origin"));
        if (!rp) return c.json({ error: "Unrecognized origin" }, 400);

        const options = await generateAuthenticationOptions({
          rpID: rp.rpID,
          allowCredentials: [], // empty → discoverable credentials
          userVerification: "preferred",
        });
        const challengeToken = await signChallenge(c.env.AUTHN_CHALLENGE_SIGNING_SECRET, {
          challenge: options.challenge,
          rpID: rp.rpID,
          origin: rp.origin,
        });
        return c.json({ challengeToken, options });
      })
      .post(
        "/auth/passkey/verify",
        zodBody(PasskeyVerifyRequest, "A passkey response is required"),
        async (c) => {
          const { challengeToken, response } = c.req.valid("json");
          const payload = await verifyChallenge(
            c.env.AUTHN_CHALLENGE_SIGNING_SECRET,
            challengeToken,
          );
          if (!payload) return c.json({ error: "This sign-in expired. Try again." }, 400);

          const db = getDb(c.env.DB);
          const cred = await db.query.credential.findFirst({
            where: eq(credential.id, response.id),
          });
          if (!cred) return c.json({ error: "Unknown passkey" }, 401);

          const verification = await deps.verifyAuthentication({
            response: response as unknown as AuthenticationResponseJSON,
            expectedChallenge: payload.challenge,
            expectedOrigin: payload.origin,
            expectedRPID: payload.rpID,
            credential: {
              id: cred.id,
              publicKey: decodePublicKey(cred.publicKey),
              counter: cred.counter,
              transports: (cred.transports ?? undefined) as
                | AuthenticatorTransportFuture[]
                | undefined,
            },
            requireUserVerification: false,
          });
          if (!verification.verified) return c.json({ error: "Passkey verification failed" }, 401);

          await db
            .update(credential)
            .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: nowIso() })
            .where(eq(credential.id, cred.id));

          return c.json({ token: await createToken(cred.userId, c.env.JWT_SECRET, cred.id) });
        },
      )
      // --- Enrollment (via invite token, or in-session on the current device) -
      .post(
        "/auth/register/options",
        zodBody(RegisterOptionsRequest, "A valid request is required"),
        async (c) => {
          const rp = resolveRp(c.env, c.req.header("Origin"));
          if (!rp) return c.json({ error: "Unrecognized origin" }, 400);

          const { inviteToken } = c.req.valid("json");
          const db = getDb(c.env.DB);

          // Resolve who we're enrolling for: an invite token, else the current
          // session (adding another passkey to your own account).
          let userId: string;
          if (inviteToken) {
            const row = await db.query.invite.findFirst({ where: eq(invite.token, inviteToken) });
            if (!row || row.expiresAt <= nowIso())
              return c.json({ error: "This link is invalid or has expired" }, 400);
            userId = row.userId;
          } else {
            const sessionUserId = await getRequestUserId(c);
            if (!sessionUserId) return c.json({ error: "Unauthorized" }, 401);
            userId = sessionUserId;
          }

          const target = await db.query.user.findFirst({ where: eq(user.id, userId) });
          if (!target) return c.json({ error: "Account not found" }, 404);

          const existing = await db.query.credential.findMany({
            where: eq(credential.userId, userId),
          });

          const options = await generateRegistrationOptions({
            rpName: c.env.WEBAUTHN_RP_NAME,
            rpID: rp.rpID,
            userName: target.email ?? target.name ?? target.id,
            userID: new TextEncoder().encode(target.id) as Uint8Array<ArrayBuffer>,
            userDisplayName: target.name ?? target.email ?? "",
            attestationType: "none",
            excludeCredentials: existing.map((cred) => ({
              id: cred.id,
              transports: (cred.transports ?? undefined) as
                | AuthenticatorTransportFuture[]
                | undefined,
            })),
            // Resident key so sign-in can be usernameless (discoverable).
            authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
          });
          const challengeToken = await signChallenge(c.env.AUTHN_CHALLENGE_SIGNING_SECRET, {
            challenge: options.challenge,
            rpID: rp.rpID,
            origin: rp.origin,
            userId,
            inviteToken,
          });
          return c.json({ challengeToken, options });
        },
      )
      .post(
        "/auth/register/verify",
        zodBody(RegisterVerifyRequest, "A passkey response is required"),
        async (c) => {
          const { challengeToken, response, name } = c.req.valid("json");
          const payload = await verifyChallenge(
            c.env.AUTHN_CHALLENGE_SIGNING_SECRET,
            challengeToken,
          );
          if (!payload?.userId)
            return c.json({ error: "This link expired. Request a new one." }, 400);

          const verification = await deps.verifyRegistration({
            response: response as unknown as RegistrationResponseJSON,
            expectedChallenge: payload.challenge,
            expectedOrigin: payload.origin,
            expectedRPID: payload.rpID,
            requireUserVerification: false,
          });
          if (!verification.verified || !verification.registrationInfo)
            return c.json({ error: "Passkey setup failed" }, 400);

          const info = verification.registrationInfo;
          const db = getDb(c.env.DB);
          const existing = await db.query.credential.findFirst({
            where: eq(credential.id, info.credential.id),
          });
          if (existing) return c.json({ error: "This passkey is already registered" }, 409);

          await db.insert(credential).values({
            id: info.credential.id,
            userId: payload.userId,
            name: name ?? "Passkey",
            publicKey: encodePublicKey(info.credential.publicKey),
            counter: info.credential.counter,
            transports: info.credential.transports ?? null,
            aaguid: info.aaguid,
            deviceType: info.credentialDeviceType,
            backedUp: info.credentialBackedUp,
            lastUsedAt: nowIso(),
          });

          // Enrolling through an invite consumes it.
          if (payload.inviteToken) {
            await db.delete(invite).where(eq(invite.token, payload.inviteToken));
          }

          return c.json({
            token: await createToken(payload.userId, c.env.JWT_SECRET, info.credential.id),
          });
        },
      )
      // --- Invites / recovery ------------------------------------------------
      // Self-serve: "email me a sign-in link" from the login page. Also the
      // migration path for magic-link users and the lost-device reset. Always
      // 200 regardless of whether the email exists (anti-enumeration).
      .post("/auth/recover", zodBody(RecoverRequest, "A valid email is required"), async (c) => {
        const { email } = c.req.valid("json");
        const rateLimit = await c.env.AUTH_RATE_LIMITER.limit({ key: email });
        if (!rateLimit.success)
          return c.json({ error: "Please wait before requesting another link" }, 429);

        const db = getDb(c.env.DB);
        const target = await db.query.user.findFirst({ where: eq(user.email, email) });
        if (target?.email) {
          const { token } = await createInvite(db, target.id, RECOVERY_TTL_SECONDS);
          const body = enrollEmail(enrollLink(c.req.url, token), "recovery");
          await c.env.EMAIL.send({
            to: target.email,
            from: { email: c.env.AUTH_EMAIL_FROM, name: "Scorecard" },
            subject: "Sign in to Scorecard",
            ...body,
          });
        }
        return c.json({ ok: true });
      })
      // Logged-in "add a new device": email yourself an enroll link.
      .post("/auth/invite/self", requireAuth, async (c) => {
        const target = await getCurrentUser(c);
        if (!target) return c.json({ error: "Unauthorized" }, 401);
        if (!target.email) return c.json({ error: "Add an email to your profile first" }, 400);

        const db = getDb(c.env.DB);
        const { token } = await createInvite(db, target.id, RECOVERY_TTL_SECONDS);
        const body = enrollEmail(enrollLink(c.req.url, token), "recovery");
        await c.env.EMAIL.send({
          to: target.email,
          from: { email: c.env.AUTH_EMAIL_FROM, name: "Scorecard" },
          subject: "Set up Scorecard on another device",
          ...body,
        });
        return c.json({ ok: true });
      })
      // The enroll page reads this to show whose account it's setting up.
      .get("/auth/invite/:token", async (c) => {
        const db = getDb(c.env.DB);
        const row = await db.query.invite.findFirst({
          where: eq(invite.token, c.req.param("token")),
          with: { user: { columns: { name: true, email: true } } },
        });
        if (!row) return c.json({ error: "Invite not found" }, 404);
        if (row.expiresAt <= nowIso()) return c.json({ error: "This link has expired" }, 410);
        return c.json({ invite: { name: row.user.name, email: row.user.email } });
      })
      // --- Credential management (self-owned) --------------------------------
      .get("/auth/credentials", requireAuth, async (c) => {
        const db = getDb(c.env.DB);
        const rows = await db.query.credential.findMany({
          where: eq(credential.userId, c.get("authUserId")),
          columns: { id: true, name: true, createdAt: true, lastUsedAt: true },
          orderBy: [asc(credential.createdAt)],
        });
        // Flag the passkey this session was minted from as the current device.
        const currentId = c.get("authCredentialId");
        const credentials = rows.map((row) => ({ ...row, current: row.id === currentId }));
        return c.json({ credentials });
      })
      .patch(
        "/auth/credentials/:id",
        requireAuth,
        zodBody(RenameCredentialRequest, "A name is required"),
        async (c) => {
          const db = getDb(c.env.DB);
          const [updated] = await db
            .update(credential)
            .set({ name: c.req.valid("json").name })
            .where(
              and(eq(credential.id, c.req.param("id")), eq(credential.userId, c.get("authUserId"))),
            )
            .returning({ id: credential.id, name: credential.name });
          if (!updated) return c.json({ error: "Passkey not found" }, 404);
          return c.json({ credential: updated });
        },
      )
      .delete("/auth/credentials/:id", requireAuth, async (c) => {
        const db = getDb(c.env.DB);
        const [deleted] = await db
          .delete(credential)
          .where(
            and(eq(credential.id, c.req.param("id")), eq(credential.userId, c.get("authUserId"))),
          )
          .returning({ id: credential.id });
        if (!deleted) return c.json({ error: "Passkey not found" }, 404);
        return c.json({ ok: true });
      })
  );
}

export const authRoutes = createAuthRoutes();
