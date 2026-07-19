import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser, requireAuth } from "./shared";

export const userRoutes = new Hono<Env>().get("/me", requireAuth, async (c) => {
  const existingUser = await getCurrentUser(c);
  if (!existingUser) return c.json({ error: "User not found" }, 404);

  return c.json({ user: existingUser });
});
