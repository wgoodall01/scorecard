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

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function createToken(email: string, secret: string) {
  return Jwt.sign(
    { email, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS },
    secret,
    "HS256",
  );
}

async function getTokenEmail(token: string, secret: string) {
  try {
    const payload = await Jwt.verify(token, secret, "HS256");
    // Jwt.verify only checks exp when the claim is present; every token we
    // mint expires, so one without exp is not ours.
    if (typeof payload.exp !== "number") return null;
    const email = Email.safeParse(payload.email);
    return email.success ? normalizeEmail(email.data) : null;
  } catch {
    return null;
  }
}

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  const email = token ? await getTokenEmail(token, c.env.JWT_SECRET) : null;

  if (!email) return c.json({ error: "Unauthorized" }, 401);

  c.set("authEmail", email);
  await next();
});

export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  const db = getDb(c.env.DB);
  const existingUser = await db.query.user.findFirst({ where: eq(user.email, c.get("authEmail")) });
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
