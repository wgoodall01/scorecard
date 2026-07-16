# Scorecard

Scorecard ingests golf-scorecard images, stores them in R2, extracts round data,
and calculates golf metrics, prizes, and awards. The current implementation is a
minimal Cloudflare deployment foundation with a typed ping endpoint.

## Architecture

- `pkg/web`: Vite + React + TypeScript front end, styled with Tailwind and
  shadcn/ui. `src/lib/api.ts` creates Hono's typed RPC client from the API's
  exported `AppType`.
- `pkg/api`: Cloudflare Worker written with Hono + TypeScript. Its default
  export is the Worker app and `POST /api/ping` responds with `{ time: Date }`.
- `wrangler.toml`: deployment configuration at the repository root. It serves
  `pkg/web/dist` as SPA assets, runs the Worker first for `/api/*`, and binds
  `DB` to the `scorecard` D1 database and `BUCKET` to the `scorecard` R2 bucket.
- `pkg/api/schema.ts`: Drizzle schema. Generated SQL migrations belong in
  `pkg/api/migrations` and are applied by Wrangler.

## Commands

- `pnpm dev`: run the Worker locally on port 8787.
- `pnpm dev:web`: run Vite locally; its `/api` requests proxy to the Worker.
- `pnpm typecheck`: typecheck all workspace packages.
- `pnpm build`: build the Vite app.
- `pnpm db:generate`: generate D1 SQL migrations from the Drizzle schema.
- `pnpm db:migrate:local` / `pnpm db:migrate:remote`: apply migrations.
- `pnpm deploy`: builds the front end through the package `predeploy` lifecycle,
  then deploys the Worker and static assets with Wrangler.

## Conventions

- Keep API routes in `pkg/api/server.ts` and export `AppType` after adding a
  route so the web RPC client remains type-safe.
- Use Drizzle's D1 adapter from `pkg/api/db.ts` for database access; do not use
  raw D1 queries unless there is a concrete reason.
- Never commit Cloudflare credentials or generated `.wrangler` state.
