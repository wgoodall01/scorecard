import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { computeHonors } from "../src/honors";
import { NaiveDate, requireAuth, zodQuery } from "./shared";

// The honors board is recomputed from scratch on every request — the window
// is one league's outings in a date range, so there's nothing worth caching
// yet. The range defaults to the current calendar year (UTC).
export const honorRoutes = new Hono<Env>().get(
  "/honors",
  requireAuth,
  zodQuery(
    z.object({ from: NaiveDate.optional(), to: NaiveDate.optional() }),
    "Invalid honors date range",
  ),
  async (c) => {
    const query = c.req.valid("query");
    const year = new Date().toISOString().slice(0, 4);
    const from = query.from ?? `${year}-01-01`;
    const to = query.to ?? `${year}-12-31`;
    const honors = await computeHonors(c.env.DB, from, to);
    return c.json({ from, to, honors });
  },
);
