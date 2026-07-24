import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { invite as inviteTable, nickname, TEES, user } from "../schema";
import { enrollEmail } from "../src/email/templates/enroll_link";
import { randomToken } from "../src/auth/webauthn";
import { computeHandicap } from "../src/handicap";
import { afterIdWhere, loadPageById, PageRef } from "../src/pagination";
import { Email, getCurrentUser, requireAuth, zodBody, zodQuery } from "./shared";

export const Nickname = z.object({
  nickname: z.string().trim().min(1),
  nicknameType: z.string().trim().min(1),
});
export type NicknameSchema = z.infer<typeof Nickname>;

// The nickname_user_nickname_unique index forbids case-insensitive duplicate
// nicknames per golfer; reject them at the request edge so the write can't
// trip the constraint.
export const Nicknames = z
  .array(Nickname)
  .refine(
    (list) => new Set(list.map((entry) => entry.nickname.toLowerCase())).size === list.length,
  );
export type NicknamesSchema = z.infer<typeof Nicknames>;

export const InviteGolferRequest = z.object({
  email: Email,
  name: z.string().trim().min(1).optional(),
  nicknames: Nicknames.optional(),
});
export type InviteGolferRequestSchema = z.infer<typeof InviteGolferRequest>;

export const UpdateGolferRequest = z
  .object({
    name: z.string().trim().min(1).nullable().optional(),
    email: Email.nullable().optional(),
    admin: z.boolean().optional(),
    preferredTee: z.enum(TEES).nullable().optional(),
    gender: z.enum(["m", "f"]).nullable().optional(),
    // Replace-all semantics: the full nickname list the golfer should end up with.
    nicknames: Nicknames.optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0);
export type UpdateGolferRequestSchema = z.infer<typeof UpdateGolferRequest>;

// The user_email_unique index is the source of truth for email uniqueness;
// map its violation to the 409 instead of pre-checking (which would race).
function isEmailConflict(error: unknown) {
  return (
    error instanceof DrizzleQueryError &&
    String(error.cause?.message ?? error.cause).includes("UNIQUE constraint failed: user.email")
  );
}

async function getGolfer(db: ReturnType<typeof getDb>, id: string) {
  return await db.query.user.findFirst({
    where: eq(user.id, id),
    with: { nicknames: true },
  });
}

async function replaceNicknames(
  db: ReturnType<typeof getDb>,
  userId: string,
  nicknames: NicknameSchema[],
) {
  await db.delete(nickname).where(eq(nickname.userId, userId));
  if (nicknames.length > 0) {
    await db.insert(nickname).values(nicknames.map((entry) => ({ ...entry, userId })));
  }
}

// Free-text golfer search, matched in SQL over name, email, and nicknames
// (SQLite LIKE is case-insensitive for ASCII). It has to run in the database,
// not over the loaded page — a search that only saw the first page would miss
// everyone behind it.
function golferSearch(db: ReturnType<typeof getDb>, query: string) {
  const pattern = `%${query}%`;
  return or(
    like(user.name, pattern),
    like(user.email, pattern),
    inArray(
      user.id,
      db.select({ id: nickname.userId }).from(nickname).where(like(nickname.nickname, pattern)),
    ),
  );
}

export const golferRoutes = new Hono<Env>()
  // Newest golfer first (uuidv7 ids), one page at a time.
  .get(
    "/golfers",
    requireAuth,
    zodQuery(
      z.object({ q: z.string().trim().optional(), ...PageRef.shape }),
      "Invalid golfer filters",
    ),
    async (c) => {
      const db = getDb(c.env.DB);
      const { q, ...ref } = c.req.valid("query");
      const search = q ? golferSearch(db, q) : undefined;

      const page = await loadPageById(ref, ({ afterId, limit }) =>
        db.query.user.findMany({
          where: and(search, afterIdWhere(user.id, afterId)),
          orderBy: [desc(user.id)],
          limit,
          with: { nicknames: true },
        }),
      );
      return c.json(page);
    },
  )
  .get("/golfers/:id", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const golfer = await getGolfer(db, c.req.param("id"));
    if (!golfer) return c.json({ error: "Golfer not found" }, 404);

    return c.json({ golfer });
  })
  // The golfer's WHS Handicap Index, recomputed from the full scoring record
  // on every request (honors-style: one league's data, nothing to cache).
  .get("/golfers/:id/handicap", requireAuth, async (c) => {
    const handicap = await computeHandicap(c.env.DB, c.req.param("id"));
    return c.json({ handicap });
  })
  .patch(
    "/golfers/:id",
    requireAuth,
    zodBody(UpdateGolferRequest, "A valid golfer update is required"),
    async (c) => {
      const id = c.req.param("id");
      const { nicknames, ...fields } = c.req.valid("json");
      const db = getDb(c.env.DB);

      // Golfers can edit their own profile; admins can edit anyone. Only an
      // admin can change the admin flag, and never their own (so the last
      // admin can't lock everyone out).
      const authUser = await getCurrentUser(c);
      if (!authUser) return c.json({ error: "Unauthorized" }, 401);
      const isSelf = authUser.id === id;
      if (!authUser.admin && !isSelf) return c.json({ error: "Forbidden" }, 403);
      if (fields.admin !== undefined && (!authUser.admin || isSelf)) {
        return c.json({ error: "Forbidden" }, 403);
      }

      try {
        if (Object.keys(fields).length > 0) {
          const [updatedUser] = await db
            .update(user)
            .set(fields)
            .where(eq(user.id, id))
            .returning();
          if (!updatedUser) return c.json({ error: "Golfer not found" }, 404);
        } else if (!(await db.query.user.findFirst({ where: eq(user.id, id) }))) {
          return c.json({ error: "Golfer not found" }, 404);
        }
        if (nicknames) await replaceNicknames(db, id, nicknames);
      } catch (error) {
        if (isEmailConflict(error))
          return c.json({ error: "An account already exists for this email" }, 409);
        throw error;
      }

      const golfer = await getGolfer(db, id);
      if (!golfer) return c.json({ error: "Golfer not found" }, 404);
      return c.json({ golfer });
    },
  )
  .post(
    "/golfers/invite",
    requireAuth,
    zodBody(InviteGolferRequest, "A valid email is required"),
    async (c) => {
      const request = c.req.valid("json");
      const db = getDb(c.env.DB);

      const authUser = await getCurrentUser(c);
      if (!authUser?.admin) return c.json({ error: "Forbidden" }, 403);

      // Inviting is idempotent on email: an existing golfer (e.g. one seeded
      // before they ever signed in) just gets the invite email re-sent, and
      // their stored name/nicknames are left alone.
      let invitedUser;
      try {
        [invitedUser] = await db
          .insert(user)
          .values({ email: request.email, name: request.name ?? null })
          .returning();
        if (request.nicknames && request.nicknames.length > 0) {
          await replaceNicknames(db, invitedUser.id, request.nicknames);
        }
      } catch (error) {
        if (!isEmailConflict(error)) throw error;
        invitedUser = await db.query.user.findFirst({ where: eq(user.email, request.email) });
        if (!invitedUser) throw error;
      }

      // Create an invite token and email a one-click enroll link (7-day
      // window); the invitee sets up a passkey and is signed straight in.
      const token = randomToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await db.insert(inviteTable).values({ userId: invitedUser.id, token, expiresAt });
      const enrollUrl = new URL("/enroll", c.req.url);
      enrollUrl.searchParams.set("token", token);
      const emailBody = enrollEmail(enrollUrl, "invite");
      await c.env.EMAIL.send({
        to: request.email,
        from: { email: c.env.AUTH_EMAIL_FROM, name: "Scorecard" },
        subject: "You're invited to Scorecard",
        ...emailBody,
      });

      const golfer = await getGolfer(db, invitedUser.id);
      return c.json({ golfer }, 201);
    },
  );
