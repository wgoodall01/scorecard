import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { getDb } from "./db";
import { user, uuidv7 } from "./schema";

export type Env = {
  Bindings: {
    DB: D1Database;
    BUCKET: R2Bucket;
    ASSETS: Fetcher;
    AUTH_CODES: KVNamespace;
    AUTH_RATE_LIMITER: RateLimit;
    EMAIL: SendEmail;
    AUTH_EMAIL_FROM: string;
    JWT_SECRET: string;
  };
  Variables: {
    authEmail: string;
  };
};

const CODE_TTL_SECONDS = 10 * 60;
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

type CaptureStatus = "processing" | "complete" | "failed";

type CaptureRecord = {
  email: string;
  status: CaptureStatus;
};

const WIP_EXTRACTION_RESULT = {
  version: 1,
  courseName: null,
  sets: [],
};

export const Email = z.string().trim().toLowerCase().email();
export type EmailSchema = z.infer<typeof Email>;

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

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isEmail(email: string) {
  return Email.safeParse(email).success;
}

function createCode() {
  const values = crypto.getRandomValues(new Uint32Array(6));
  return [...values].map((value) => String(value % 10)).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

async function codeKey(email: string) {
  return `auth:code:${await sha256(email)}`;
}

function captureKey(captureId: string, name: "image" | "capture.json" | "extracted.json") {
  return `cards/${captureId}/${name}`;
}

async function putCaptureRecord(env: Env["Bindings"], captureId: string, record: CaptureRecord) {
  await env.BUCKET.put(captureKey(captureId, "capture.json"), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function extractCapture(env: Env["Bindings"], captureId: string, email: string) {
  // The queue/vision-model step will replace this WIP extractor. Keeping the result
  // in R2 already gives the UI the final polling contract.
  await env.BUCKET.put(
    captureKey(captureId, "extracted.json"),
    JSON.stringify(WIP_EXTRACTION_RESULT),
    { httpMetadata: { contentType: "application/json" } },
  );
  await putCaptureRecord(env, captureId, { email, status: "complete" });
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

async function createToken(email: string, secret: string) {
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
      !isEmail(parsedPayload.email ?? "") ||
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

async function readRequestBody<TSchema extends z.ZodType>(
  c: { req: { json: <T>() => Promise<T> } },
  schema: TSchema,
): Promise<z.output<TSchema> | null> {
  try {
    const result = schema.safeParse(await c.req.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const requireAuth = createMiddleware<Env>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  const email = token ? await getTokenEmail(token, c.env.JWT_SECRET) : null;

  if (!email) return c.json({ error: "Unauthorized" }, 401);

  c.set("authEmail", email);
  await next();
});

const app = new Hono<Env>()
  .basePath("/api")
  .post("/ping", (c) => c.json({ time: new Date() }))
  .post("/capture/submit", requireAuth, async (c) => {
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_BYTES)
      return c.json({ error: "Images must be 10 MB or smaller" }, 413);

    const form = await c.req.formData().catch(() => null);
    const image = form?.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/"))
      return c.json({ error: "An image file is required" }, 400);
    if (image.size > MAX_CAPTURE_BYTES)
      return c.json({ error: "Images must be 10 MB or smaller" }, 413);

    const captureId = uuidv7();
    const email = c.get("authEmail");
    await c.env.BUCKET.put(captureKey(captureId, "image"), image.stream(), {
      httpMetadata: { contentType: image.type },
    });
    await putCaptureRecord(c.env, captureId, { email, status: "processing" });

    c.executionCtx.waitUntil(
      extractCapture(c.env, captureId, email).catch(async (error) => {
        console.error("Capture extraction failed", { captureId, error });
        await putCaptureRecord(c.env, captureId, { email, status: "failed" });
      }),
    );

    return c.json({ id: captureId }, 202);
  })
  .get("/capture/result", requireAuth, async (c) => {
    const captureId = c.req.query("id");
    if (!captureId) return c.json({ error: "A capture id is required" }, 400);

    const recordObject = await c.env.BUCKET.get(captureKey(captureId, "capture.json"));
    if (!recordObject) return c.json({ error: "Capture not found" }, 404);

    const record = await recordObject.json<CaptureRecord>();
    if (record.email !== c.get("authEmail")) return c.json({ error: "Capture not found" }, 404);
    if (record.status === "failed") return c.json({ error: "Capture extraction failed" }, 500);
    if (record.status === "processing") return c.json({ status: "processing" }, 202);

    const resultObject = await c.env.BUCKET.get(captureKey(captureId, "extracted.json"));
    if (!resultObject) return c.json({ error: "Capture result not found" }, 500);
    return c.json(await resultObject.json());
  })
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
  })
  .get("/me", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const existingUser = await db.query.user.findFirst({
      where: eq(user.email, c.get("authEmail")),
    });
    if (!existingUser) return c.json({ error: "User not found" }, 404);

    return c.json({ user: existingUser });
  });

export type AppType = typeof app;

export default app;
