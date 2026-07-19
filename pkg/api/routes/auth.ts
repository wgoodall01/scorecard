import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { user } from "../schema";
import { issueCode, magicLink, redeemCode } from "../src/auth/magic";
import { signInEmail } from "../src/email/templates/sign_in";
import { createToken, Email, readRequestBody } from "./shared";

export const AuthCodeRequest = z.object({ email: Email });
export type AuthCodeRequestSchema = z.infer<typeof AuthCodeRequest>;

export const AuthTokenRequest = z.object({
  email: Email,
  code: z.string().regex(/^\d{6}$/),
});
export type AuthTokenRequestSchema = z.infer<typeof AuthTokenRequest>;

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

    const code = await issueCode(c.env, email);
    const emailBody = signInEmail(code, magicLink(c.req.url, email, code));
    await c.env.EMAIL.send({
      to: email,
      from: { email: c.env.AUTH_EMAIL_FROM, name: "Scorecard" },
      subject: `Your Scorecard sign-in code: ${code}`,
      ...emailBody,
    });

    return c.json({ ok: true });
  })
  .post("/auth/token", async (c) => {
    const request = await readRequestBody(c, AuthTokenRequest);
    if (!request) return c.json({ error: "A valid email and 6-digit code are required" }, 400);

    if (!(await redeemCode(c.env, request.email, request.code))) {
      return c.json({ error: "Invalid or expired code" }, 401);
    }
    return c.json({ token: await createToken(request.email, c.env.JWT_SECRET) });
  });
