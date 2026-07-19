import { asc, eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { nickname, TEES, user } from "../schema";
import { inviteEmail } from "../src/email/templates/invite";
import { computeHandicap } from "../src/handicap";
import { Email, requireAuth, zodBody } from "./shared";

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
    handicap: z.number().int().min(-10).max(54).nullable().optional(),
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

async function getAuthUser(db: ReturnType<typeof getDb>, authEmail: string) {
  return await db.query.user.findFirst({ where: eq(user.email, authEmail) });
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

export const golferRoutes = new Hono<Env>()
  .get("/golfers", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const golfers = await db.query.user.findMany({
      with: { nicknames: true },
      orderBy: [asc(user.name), asc(user.email)],
    });
    return c.json({ golfers });
  })
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
      const authUser = await getAuthUser(db, c.get("authEmail"));
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

      const authUser = await getAuthUser(db, c.get("authEmail"));
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

      const loginLink = new URL("/login", c.req.url);
      loginLink.searchParams.set("email", request.email);
      const emailBody = inviteEmail(loginLink);
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
