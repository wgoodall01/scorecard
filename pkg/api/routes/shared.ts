import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { Jwt } from "hono/utils/jwt";
import { validator } from "hono/validator";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { user } from "../schema";

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const Email = z.string().trim().toLowerCase().email();
export type EmailSchema = z.infer<typeof Email>;

// A naive "YYYY-MM-DD" calendar date, the app's date-of-play currency.
export const NaiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type NaiveDateSchema = z.infer<typeof NaiveDate>;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

// The session JWT's subject is the user id — NOT the email. Passkey identity
// is decoupled from email (a user may have a null email and still sign in),
// and email can change without invalidating a session. `cred` records WHICH
// passkey minted this session (from sign-in or enrollment), so the UI can flag
// the credential in use as "this device".
export async function createToken(userId: string, secret: string, credentialId?: string) {
  return Jwt.sign(
    {
      sub: userId,
      ...(credentialId ? { cred: credentialId } : {}),
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    },
    secret,
    "HS256",
  );
}

async function getTokenClaims(token: string, secret: string) {
  try {
    const payload = await Jwt.verify(token, secret, "HS256");
    // Jwt.verify only checks exp when the claim is present; every token we
    // mint expires, so one without exp is not ours.
    if (typeof payload.exp !== "number") return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return { sub: payload.sub, cred: typeof payload.cred === "string" ? payload.cred : null };
  } catch {
    return null;
  }
}

// The signed-in user's id from the request's bearer token, or null when the
// token is missing/invalid/expired. requireAuth builds on this; routes that
// accept EITHER a session or an unauthenticated path (e.g. passkey enrollment
// via an invite token) call it directly.
export async function getRequestUserId(c: Context<Env>): Promise<string | null> {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  const claims = token ? await getTokenClaims(token, c.env.JWT_SECRET) : null;
  return claims?.sub ?? null;
}

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  const claims = token ? await getTokenClaims(token, c.env.JWT_SECRET) : null;

  if (!claims) return c.json({ error: "Unauthorized" }, 401);

  c.set("authUserId", claims.sub);
  // Which passkey this session was minted from (null for tokens without it).
  c.set("authCredentialId", claims.cred);
  await next();
});

// The signed-in user's row (from requireAuth's authUserId), or null/undefined
// if the token's subject no longer maps to a user. Use after requireAuth.
export async function getCurrentUser(c: Context<Env>) {
  const db = getDb(c.env.DB);
  return await db.query.user.findFirst({ where: eq(user.id, c.get("authUserId")) });
}

export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  const existingUser = await getCurrentUser(c);
  if (!existingUser?.admin) return c.json({ error: "Forbidden" }, 403);

  await next();
});

// Validate the JSON request body against a zod schema, replying 400 with
// `message` when it doesn't parse. Middleware (rather than readRequestBody)
// so Hono's RPC client types the route's `json` payload.
export function zodBody<TSchema extends z.ZodType>(schema: TSchema, message: string) {
  return validator("json", (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) return c.json({ error: message }, 400);
    return result.data;
  });
}

// Query-string counterpart of zodBody, for the same RPC-typing reason.
export function zodQuery<TSchema extends z.ZodType>(schema: TSchema, message: string) {
  return validator("query", (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) return c.json({ error: message }, 400);
    return result.data;
  });
}

export async function readRequestBody<TSchema extends z.ZodType>(
  c: Context<Env>,
  schema: TSchema,
): Promise<z.output<TSchema> | null> {
  try {
    const result = schema.safeParse(await c.req.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
