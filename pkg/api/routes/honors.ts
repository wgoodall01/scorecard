import { Hono } from "hono";
import type { Env } from "../env";
import { computeHonors, HONOR_WINDOW_DAYS } from "../src/honors";
import { requireAuth } from "./shared";

// The honors board is recomputed from scratch on every request — the window
// is one league's recent outings, so there's nothing worth caching yet.
export const honorRoutes = new Hono<Env>().get("/honors", requireAuth, async (c) => {
  const since = new Date(Date.now() - HONOR_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const honors = await computeHonors(c.env.DB, since);
  return c.json({ since, windowDays: HONOR_WINDOW_DAYS, honors });
});
