import { Hono } from "hono"

export type Env = {
  Bindings: {
    DB: D1Database
    BUCKET: R2Bucket
    ASSETS: Fetcher
  }
}

const app = new Hono<Env>().basePath("/api").post("/ping", (c) => {
  return c.json({ time: new Date() })
})

export type AppType = typeof app

export default app
