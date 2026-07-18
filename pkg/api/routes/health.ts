import { Hono } from "hono";
import type { Env } from "../env";

export const healthRoutes = new Hono<Env>()
  .post("/ping", (c) => c.json({ time: new Date() }))
  // Unauthenticated GET so uptime checks (and humans with curl) can verify
  // the Worker is serving without minting a token.
  .get("/health", (c) => c.json({ ok: true, time: new Date() }));
