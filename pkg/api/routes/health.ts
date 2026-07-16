import { Hono } from "hono";
import type { Env } from "../env";

export const healthRoutes = new Hono<Env>().post("/ping", (c) => c.json({ time: new Date() }));
