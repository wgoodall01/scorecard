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

function createSignInEmail(code: string, magicLink: URL) {
  const magicLinkHref = magicLink.toString().replaceAll("&", "&amp;");

  return {
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in to Scorecard</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f5f7f6; color:#17211b; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse; background-color:#f5f7f6;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:560px; border-collapse:collapse; background-color:#ffffff; border:1px solid #dce5df; border-radius:12px;">
            <tr>
              <td style="padding:32px 32px 8px;">
                <p style="margin:0; color:#16824b; font-size:18px; font-weight:700; letter-spacing:-0.2px;">Scorecard</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 8px;">
                <h1 style="margin:0; color:#17211b; font-size:26px; font-weight:700; line-height:1.25;">Sign in to Scorecard</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 24px;">
                <p style="margin:0; color:#526158; font-size:16px; line-height:1.5;">Use this one-time code to sign in. It expires in 10 minutes.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 24px;">
                <p style="margin:0; padding:14px 20px; color:#17211b; background-color:#eef7f0; border:1px solid #cce4d2; border-radius:8px; font-family:Arial, Helvetica, sans-serif; font-size:28px; font-weight:700; letter-spacing:8px; line-height:1;">${code}</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 32px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                  <tr>
                    <td align="center" bgcolor="#16824b" style="border-radius:8px;">
                      <a href="${magicLinkHref}" style="display:inline-block; padding:14px 20px; color:#ffffff; font-size:16px; font-weight:700; line-height:1; text-decoration:none;">Sign in to Scorecard</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 32px; border-top:1px solid #e7ede9;">
                <p style="margin:0; color:#718075; font-size:13px; line-height:1.5;">If you did not request this email, you can safely ignore it.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    text: `Your Scorecard sign-in code is: ${code}\n\nThis code expires in 10 minutes. If you did not request it, you can safely ignore this email.`,
  };
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
    const emailBody = createSignInEmail(code, magicLink);
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
