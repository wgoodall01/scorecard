import { eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { user } from "../schema";
import { inviteEmail } from "../src/email/templates/invite";
import { Email, requireAdmin, requireAuth, zodBody } from "./shared";

export const InviteRequest = z.object({
  email: Email,
  name: z.string().trim().min(1).optional(),
});
export type InviteRequestSchema = z.infer<typeof InviteRequest>;

export const UpdateUserRequest = z
  .object({
    name: z.string().trim().min(1).nullable().optional(),
    email: Email.optional(),
    admin: z.boolean().optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0);
export type UpdateUserRequestSchema = z.infer<typeof UpdateUserRequest>;

// The user_email_unique index is the source of truth for email uniqueness;
// map its violation to the 409 instead of pre-checking (which would race).
function isEmailConflict(error: unknown) {
  return (
    error instanceof DrizzleQueryError &&
    String(error.cause?.message ?? error.cause).includes("UNIQUE constraint failed: user.email")
  );
}

export const adminRoutes = new Hono<Env>()
  .get("/admin/users", requireAuth, requireAdmin, async (c) => {
    const db = getDb(c.env.DB);
    const users = await db.query.user.findMany();
    return c.json({ users });
  })
  .get("/admin/users/:id", requireAuth, requireAdmin, async (c) => {
    const db = getDb(c.env.DB);
    const foundUser = await db.query.user.findFirst({
      where: eq(user.id, c.req.param("id")),
    });
    if (!foundUser) return c.json({ error: "User not found" }, 404);

    return c.json({ user: foundUser });
  })
  .patch(
    "/admin/users/:id",
    requireAuth,
    requireAdmin,
    zodBody(UpdateUserRequest, "A valid name, email, or admin flag is required"),
    async (c) => {
      const id = c.req.param("id");
      const request = c.req.valid("json");
      const db = getDb(c.env.DB);

      try {
        const [updatedUser] = await db.update(user).set(request).where(eq(user.id, id)).returning();
        if (!updatedUser) return c.json({ error: "User not found" }, 404);

        return c.json({ user: updatedUser });
      } catch (error) {
        if (isEmailConflict(error))
          return c.json({ error: "An account already exists for this email" }, 409);
        throw error;
      }
    },
  )
  .post(
    "/admin/invite",
    requireAuth,
    requireAdmin,
    zodBody(InviteRequest, "A valid email is required"),
    async (c) => {
      const request = c.req.valid("json");
      const db = getDb(c.env.DB);
      let createdUser;
      try {
        [createdUser] = await db
          .insert(user)
          .values({ email: request.email, name: request.name ?? null })
          .returning();
      } catch (error) {
        if (isEmailConflict(error))
          return c.json({ error: "An account already exists for this email" }, 409);
        throw error;
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

      return c.json({ user: createdUser }, 201);
    },
  );
