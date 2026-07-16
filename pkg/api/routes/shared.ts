import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Env } from "../env";

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const Email = z.string().trim().toLowerCase().email();
export type EmailSchema = z.infer<typeof Email>;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function base64UrlEncode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function jwtKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createToken(email: string, secret: string) {
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await jwtKey(secret),
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getTokenEmail(token: string, secret: string) {
  const [header, payload, signature, ...rest] = token.split(".");
  if (!header || !payload || !signature || rest.length > 0) return null;

  try {
    const parsedHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as {
      alg?: string;
    };
    const parsedPayload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      email?: string;
      exp?: number;
    };
    if (
      parsedHeader.alg !== "HS256" ||
      !Email.safeParse(parsedPayload.email ?? "").success ||
      typeof parsedPayload.exp !== "number" ||
      parsedPayload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    const valid = await crypto.subtle.verify(
      "HMAC",
      await jwtKey(secret),
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return valid ? normalizeEmail(parsedPayload.email!) : null;
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
