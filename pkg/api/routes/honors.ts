import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { computeHonors } from "../src/honors";
import { requireAuth, zodQuery } from "./shared";

const NaiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HonorsQuery = z.object({
  since: NaiveDate.optional(),
  until: NaiveDate.optional(),
});

// The honors board is recomputed from scratch on every request — the window
// is one league's outings, so there's nothing worth caching yet. The default
// range is the current calendar year (UTC, matching the naive outing dates).
export const honorRoutes = new Hono<Env>().get(
  "/honors",
  requireAuth,
  zodQuery(HonorsQuery, "Invalid date range"),
  async (c) => {
    const year = new Date().toISOString().slice(0, 4);
    const { since = `${year}-01-01`, until = `${year}-12-31` } = c.req.valid("query");
    const honors = await computeHonors(c.env.DB, since, until);
    return c.json({ since, until, honors });
  },
);
