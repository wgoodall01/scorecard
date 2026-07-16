import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { getDb } from "./db"
import { user } from "./schema"

export type Env = {
  Bindings: {
    DB: D1Database
    BUCKET: R2Bucket
    ASSETS: Fetcher
    AUTH_CODES: KVNamespace
    AUTH_RATE_LIMITER: RateLimit
    EMAIL: SendEmail
    AUTH_EMAIL_FROM: string
    JWT_SECRET: string
  }
  Variables: {
    authEmail: string
  }
}

const CODE_TTL_SECONDS = 10 * 60
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function isEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function createCode() {
  const values = crypto.getRandomValues(new Uint32Array(8))
  return [...values].map((value) => String(value % 10)).join("")
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return base64UrlEncode(new Uint8Array(digest))
}

async function codeKey(email: string) {
  return `auth:code:${await sha256(email)}`
}

async function requestKey(email: string) {
  return `auth:request:${await sha256(email)}`
}

function base64UrlEncode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function base64UrlDecode(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

async function jwtKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

async function createToken(email: string, secret: string) {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }),
    ),
  )
  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign("HMAC", await jwtKey(secret), new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

async function getTokenEmail(token: string, secret: string) {
  const [header, payload, signature, ...rest] = token.split(".")
  if (!header || !payload || !signature || rest.length > 0) return null

  try {
    const parsedHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { alg?: string }
    const parsedPayload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      email?: string
      exp?: number
    }
    if (
      parsedHeader.alg !== "HS256" ||
      !isEmail(parsedPayload.email ?? "") ||
      typeof parsedPayload.exp !== "number" ||
      parsedPayload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null
    }

    const valid = await crypto.subtle.verify(
      "HMAC",
      await jwtKey(secret),
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    return valid ? normalizeEmail(parsedPayload.email!) : null
  } catch {
    return null
  }
}

async function readEmailBody(c: { req: { json: <T>() => Promise<T> } }) {
  try {
    const { email } = await c.req.json<{ email?: unknown }>()
    return typeof email === "string" ? normalizeEmail(email) : null
  } catch {
    return null
  }
}

const requireAuth = createMiddleware<Env>(async (c, next) => {
  const authorization = c.req.header("Authorization")
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null
  const email = token ? await getTokenEmail(token, c.env.JWT_SECRET) : null

  if (!email) return c.json({ error: "Unauthorized" }, 401)

  c.set("authEmail", email)
  await next()
})

const app = new Hono<Env>()
  .basePath("/api")
  .post("/ping", (c) => c.json({ time: new Date() }))
  .post("/auth/code", async (c) => {
    const email = await readEmailBody(c)
    if (!email || !isEmail(email)) return c.json({ error: "A valid email is required" }, 400)

    const rateLimit = await c.env.AUTH_RATE_LIMITER.limit({ key: email })
    if (!rateLimit.success) return c.json({ error: "Please wait before requesting another code" }, 429)

    const throttleKey = await requestKey(email)
    if (await c.env.AUTH_CODES.get(throttleKey)) {
      return c.json({ error: "Please wait before requesting another code" }, 429)
    }
    await c.env.AUTH_CODES.put(throttleKey, "1", { expirationTtl: 1 })

    const db = getDb(c.env.DB)
    const existingUser = await db.query.user.findFirst({ where: eq(user.email, email) })
    if (!existingUser) return c.json({ error: "User not found" }, 404)

    const code = createCode()
    await c.env.AUTH_CODES.put(await codeKey(email), code, { expirationTtl: CODE_TTL_SECONDS })

    const magicLink = new URL("/login/magic", c.req.url)
    magicLink.search = new URLSearchParams({ email, code }).toString()
    await c.env.EMAIL.send({
      to: email,
      from: c.env.AUTH_EMAIL_FROM,
      subject: "Your Scorecard sign-in code",
      text: `Use this code to sign in: ${code}\n\nOr open this magic link: ${magicLink.toString()}`,
    })

    return c.json({ ok: true })
  })
  .post("/auth/token", async (c) => {
    try {
      const { email: rawEmail, code } = await c.req.json<{ email?: unknown; code?: unknown }>()
      const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : null
      if (!email || !isEmail(email) || typeof code !== "string" || !/^\d{8}$/.test(code)) {
        return c.json({ error: "A valid email and 8-digit code are required" }, 400)
      }

      const key = await codeKey(email)
      const expectedCode = await c.env.AUTH_CODES.get(key)
      if (!expectedCode || expectedCode !== code) return c.json({ error: "Invalid or expired code" }, 401)

      await c.env.AUTH_CODES.delete(key)
      return c.json({ token: await createToken(email, c.env.JWT_SECRET) })
    } catch {
      return c.json({ error: "A valid email and 8-digit code are required" }, 400)
    }
  })
  .post("/auth/register", async (c) => {
    try {
      const { email: rawEmail, name: rawName } = await c.req.json<{ email?: unknown; name?: unknown }>()
      const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : null
      const name = typeof rawName === "string" ? rawName.trim() : null
      if (!email || !isEmail(email) || !name) {
        return c.json({ error: "A valid email and name are required" }, 400)
      }

      const db = getDb(c.env.DB)
      const existingUser = await db.query.user.findFirst({ where: eq(user.email, email) })
      if (existingUser) return c.json({ error: "An account already exists for this email" }, 409)

      const [createdUser] = await db.insert(user).values({ email, name }).returning()
      return c.json({ user: createdUser }, 201)
    } catch {
      return c.json({ error: "A valid email and name are required" }, 400)
    }
  })
  .get("/me", requireAuth, async (c) => {
    const db = getDb(c.env.DB)
    const existingUser = await db.query.user.findFirst({ where: eq(user.email, c.get("authEmail")) })
    if (!existingUser) return c.json({ error: "User not found" }, 404)

    return c.json({ user: existingUser })
  })

export type AppType = typeof app

export default app
