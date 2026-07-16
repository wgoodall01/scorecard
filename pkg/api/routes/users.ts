import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db";
import type { Env } from "../env";
import { user } from "../schema";
import { requireAuth } from "./shared";

export const userRoutes = new Hono<Env>().get("/me", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const existingUser = await db.query.user.findFirst({
    where: eq(user.email, c.get("authEmail")),
  });
  if (!existingUser) return c.json({ error: "User not found" }, 404);

  return c.json({ user: existingUser });
});
