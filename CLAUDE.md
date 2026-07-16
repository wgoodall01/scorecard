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

- `bun dev`: run the Worker locally on port 8787.
- `bun dev:web`: run Vite locally; its `/api` requests proxy to the Worker.
- `bun build`: build the Vite app.
- `bun lint`: lint and type-check the repository with Oxlint.
- `bun fmt`: format the repository with Oxfmt.
- `bun db:generate`: generate D1 SQL migrations from the Drizzle schema.
- `bun db:migrate:local` / `bun db:migrate:remote`: apply migrations.
- `bun deploy`: builds the front end, then deploys the Worker and static assets
  with Wrangler.

## Schemas

- Always name schemas in upper PascalCase, for example `export const FooBar = z.number()`.
- Always bind each schema's inferred type with the corresponding `Schema` suffix, for example `export type FooSchema = z.infer<typeof FooBar>`.

## Conventions

- Use Oxlint and Oxfmt for linting and formatting; do not add ESLint or Prettier configuration.
- Compose shadcn layouts with `flex flex-col gap-*` containers for vertical rhythm instead of stacking arbitrary `mt-*` utilities. Reserve `mt-auto` for intentional responsive action-bar anchoring.
- Keep `pkg/api/server.ts` as the API composition root. Add route handlers under
  `pkg/api/routes/` and export `AppType` from the server so the web RPC client
  remains type-safe.
- Use Drizzle's D1 adapter from `pkg/api/db.ts` for database access; do not use
  raw D1 queries unless there is a concrete reason.
- Never commit Cloudflare credentials or generated `.wrangler` state.
- TanStack Router for the FE.
