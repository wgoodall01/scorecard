import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { user } from "../schema";
import { createToken, Email } from "./shared";

const CODE_TTL_SECONDS = 10 * 60;

export const AuthCodeRequest = z.object({ email: Email });
export type AuthCodeRequestSchema = z.infer<typeof AuthCodeRequest>;

export const AuthTokenRequest = z.object({
  email: Email,
  code: z.string().regex(/^\d{6}$/),
});
export type AuthTokenRequestSchema = z.infer<typeof AuthTokenRequest>;

export const RegistrationRequest = z.object({
  email: Email,
  name: z.string().trim().min(1),
});
export type RegistrationRequestSchema = z.infer<typeof RegistrationRequest>;

function createCode() {
  const values = crypto.getRandomValues(new Uint32Array(6));
  return [...values].map((value) => String(value % 10)).join("");
}

function base64UrlEncode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function codeKey(email: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return `auth:code:${base64UrlEncode(new Uint8Array(digest))}`;
}

async function readRequestBody<TSchema extends z.ZodType>(
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

export const authRoutes = new Hono<Env>()
  .post("/auth/code", async (c) => {
    const request = await readRequestBody(c, AuthCodeRequest);
    if (!request) return c.json({ error: "A valid email is required" }, 400);
    const { email } = request;

    const rateLimit = await c.env.AUTH_RATE_LIMITER.limit({ key: email });
    if (!rateLimit.success)
      return c.json({ error: "Please wait before requesting another code" }, 429);

    const db = getDb(c.env.DB);
    const existingUser = await db.query.user.findFirst({ where: eq(user.email, email) });
    if (!existingUser) return c.json({ error: "User not found" }, 404);

    const code = createCode();
    await c.env.AUTH_CODES.put(await codeKey(email), code, { expirationTtl: CODE_TTL_SECONDS });

    const magicLink = new URL("/login/magic", c.req.url);
    magicLink.searchParams.set("email", email);
    magicLink.searchParams.set("code", code);
    await c.env.EMAIL.send({
      to: email,
      from: c.env.AUTH_EMAIL_FROM,
      subject: `Your Scorecard sign-in code: ${code}`,
      text: `Use this code to sign in: ${code}\n\nOr open this magic link: ${magicLink.toString()}`,
    });

    return c.json({ ok: true });
  })
  .post("/auth/token", async (c) => {
    const request = await readRequestBody(c, AuthTokenRequest);
    if (!request) return c.json({ error: "A valid email and 6-digit code are required" }, 400);

    const key = await codeKey(request.email);
    const expectedCode = await c.env.AUTH_CODES.get(key);
    if (!expectedCode || expectedCode !== request.code)
      return c.json({ error: "Invalid or expired code" }, 401);

    await c.env.AUTH_CODES.delete(key);
    return c.json({ token: await createToken(request.email, c.env.JWT_SECRET) });
  })
  .post("/auth/register", async (c) => {
    const request = await readRequestBody(c, RegistrationRequest);
    if (!request) return c.json({ error: "A valid email and name are required" }, 400);

    const db = getDb(c.env.DB);
    const existingUser = await db.query.user.findFirst({ where: eq(user.email, request.email) });
    if (existingUser) return c.json({ error: "An account already exists for this email" }, 409);

    const [createdUser] = await db.insert(user).values(request).returning();
    return c.json({ user: createdUser }, 201);
  });
