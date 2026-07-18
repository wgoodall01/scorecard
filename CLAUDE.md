# Scorecard

Scorecard ingests golf-scorecard images, stores them in R2, extracts round data,
matches it against the database (players, courses), and records outings and
scores that the app browses and will use for golf metrics, prizes, and awards.

## Architecture

- `pkg/web`: Vite + React + TypeScript front end, styled with Tailwind and
  shadcn/ui. `src/lib/api.ts` creates Hono's typed RPC client from the API's
  exported `AppType`. Page components live in `src/App.tsx` (shell, login,
  capture, me) and `src/pages/` (golfers, outings); routes under `src/routes`
  are thin `createFileRoute` wrappers. Import only TYPES from the `api`
  package (`Tee`, `ExtractDataSchema`, …) — importing a value would pull the
  Worker module graph into the web bundle (`src/lib/tees.ts` mirrors the
  `TEES` list for this reason). The capture review step
  (`src/components/review-round.tsx`) is the mobile-first editor over the
  extraction: score grid, golfer + tee pickers seeded from `matched` and
  each golfer's `preferredTee`, course/set pickers over existing courses,
  a date input defaulting to the handwritten date else today, and the
  `/outings/check`-driven "add to existing outing" prompt; submit POSTs
  `/outings` (with the capture's `scorecardId`) and links to `/outings/$id`.
  It is TWO sub-steps: date/course/golfers first, then per-nine review —
  each nine is assigned to an EXISTING course set only (no new-nine creation
  from capture; the Courses tab is the registry, and "import nines via
  scorecard" comes later), pars display from the db set, and before submit
  every handwritten total (per nine and the 18-hole totals) must be
  confirmed via a required choice: totals agree / written totals are wrong /
  I corrected a score. The Courses tab (`src/pages/courses.tsx`) lists
  courses and shows each course's nines with hole/par tables.
- `pkg/api`: Cloudflare Worker written with Hono + TypeScript. `index.ts` is
  the composition root; its default export is `{ fetch, queue }` and
  `POST /api/ping` responds with `{ time: Date }`.
- `wrangler.toml`: deployment configuration at the repository root. It serves
  `pkg/web/dist` as SPA assets, runs the Worker first for `/api/*`, and binds
  `DB` to the `scorecard` D1 database, `BUCKET` to the `scorecard` R2 bucket,
  and `IMAGES` to Cloudflare Images transforms.
- `pkg/api/schema.ts`: Drizzle schema (with `relations` for the relational
  query API). Tables: `user` (+ `handicap`, `preferred_tee` — the `TEES` const
  is the app-level tee list; `email` is NULLABLE-but-unique: a golfer can
  exist purely as a player with no account email, and can't sign in until one
  is set), `nickname` (user_id, nickname, nickname_type),
  `course`, `course_set` (a "nine"; `disposition` front/back/null; name unique
  per course), `hole` (number unique per set), `outing` (naive `date`
  "YYYY-MM-DD" + course_id), `outing_player` (per-outing tee per player),
  `scorecard` (one row per captured card; its id IS the capture id, so the
  image/extracted.json/matched.json live in R2 under it), and `score`
  (outing/player/hole unique, with a nullable `scorecard_id` recording which
  captured card each score was read from). Generated SQL migrations belong in
  `pkg/api/migrations` and are applied by Wrangler.
- `pkg/api/routes/golfers.ts`: the player registry (subsumes the old admin
  routes/page). List/get golfers with nicknames (any signed-in user); PATCH is
  self-or-admin (nicknames use replace-all semantics; the `admin` flag needs an
  admin and never on yourself); `/golfers/invite` is admin-only and sends the
  invite email. The web's Golfers tab drives all of this — there is no
  separate admin UI; controls are shown by permission checks.
- `pkg/api/routes/outings.ts`: `/courses` (with sets AND holes — the review
  UI shows database pars and auto-picks sets by par sequence);
  `/outings` list (reverse-chrono summaries; course/set/player filters);
  `/outings/check` (merge-candidate lookup: an outing on the same date with
  scores on any of the given course sets — the one-foursome-two-scorecards
  case); `/outings/:id` detail (sets derived from scores, holes, per-player
  tees, score cell maps, plus the distinct `scorecards` behind those scores);
  POST `/outings` submits a reviewed capture — it records `scorecardId` on
  every score row, can create the course and/or course sets (with holes)
  inline (API capability only: the review UI no longer offers it; it's
  reserved for the future "import nines via scorecard" flow), merge into an
  existing outing via `outingId`, upserts `outing_player` tees, and writes
  all rows through one `db.batch`.
- `pkg/api/routes/capture.ts`: routes only — `/capture/submit` uploads the
  image to R2 and enqueues a `CAPTURE_QUEUE` message; `/capture/result` polls
  the capture record and, when complete, returns `{ extracted, matched }`
  (extracted.json + matched.json from R2). It exports the shared
  `captureKey`/`putCaptureRecord` helpers for the agent module below.
- `pkg/api/src/agent/card_extract/`: the extraction agent. `agent.ts` exports
  `extractScorecard({image, resolver, model})` — one `generateObject` call
  with vision input — plus `handleCaptureQueue` (wired into `index.ts`'s
  `queue` handler), which reads the uploaded image from R2, normalizes it via
  the `IMAGES` binding (scale-down to 2048px-long-edge JPEG q80, passing
  already-conforming JPEGs through without re-encoding — the route stores raw
  uploaded bytes, size-limited only), extracts, and writes `extracted.json`. `schema.ts` defines ONE schema, `ExtractData` —
  what the model emits, what the agent returns, what's stored in R2, and what
  the eval fixtures assert; there is no wire/public split. Per-player data is
  index-aligned arrays (`players: string[]`, `scores`/`writtenTotals`:
  `(number|null)[]`), every field required, `null` = "not written/legible".
  That array shape is also the only one all three providers' structured-output
  compilers accept (Anthropic caps union-typed AND optional parameters and
  requires `additionalProperties: false`; Google rejects `const`/`z.literal`).
  The default production model is `google/gemini-3.5-flash@low`, chosen by
  the eval sweep. The queue consumer runs with
  `max_batch_size = 1` / `max_batch_timeout = 0` (no batching), processes
  batch messages with `Promise.all`, and retries a 429 (`APICallError` with
  `statusCode === 429`) up to `MAX_RATE_LIMIT_ATTEMPTS` times via
  `message.retry()`. After extraction it runs both matching agents (below)
  against `env.DB` and writes `matched.json` (`MatchedData`); matching is
  best-effort — any failure, including 429s, degrades to nulls rather than
  failing or retrying the capture, since retrying would re-spend the far more
  expensive vision call and the review UI lets the user pick manually.
- `pkg/api/src/agent/player_match/` and `pkg/api/src/agent/course_match/`:
  the matching agents. Both are agentic-search loops (no embeddings) built on
  `src/agent/answer_tool.ts`'s `runAnswerAgent`: `generateText` with
  `toolChoice: "required"`, one ILIKE-style search tool, and a terminal
  `answer` tool (no execute) whose inputSchema is the result — so the
  card_extract structured-output constraints apply to answer schemas too.
  Hallucinated ids are nulled (only ids seen in tool results survive), and
  course/set answers are forced consistent (sets must belong to the final
  course). The search functions are injected: `search.ts` in each module has
  the production Drizzle version (SQLite LIKE is case-insensitive for ASCII =
  ILIKE) and an in-memory version with identical semantics for evals.
  `matchPlayers` maps written names (initials, nicknames, misspellings) to
  user ids or null — ambiguity must yield null, a wrong match is worse than
  none. `matchCourseSets` maps courseName+nines to a course and per-nine
  course-set ids in two phases: FIRST a no-LLM exact match of each nine's
  (hole, par) sequence against every set in the db (unique-candidate only,
  all matches must share one course) — this is how "BLUE SPRUCE" on a card
  resolves to a set stored as just "Blue" — and only unresolved nines fall
  through to the agentic search, whose tool returns whole courses with ALL
  their sets so a distinctive nine name alone can identify the course, with
  hole numbers (1–9 vs 10–18) disambiguating unnamed nines. `runAnswerAgent`
  force-invokes the answer tool in one extra step if a model burns its step
  budget without submitting. Player-match default:
  `google/gemini-3.5-flash@low` (only model with perfect recall in the
  2026-07-17 sweep). Course-match default: `openai/gpt-5.4-nano@low` — the
  embellished-name/misread-pars fallback case defeats gemini even at medium,
  and gpt-5.4-mini guessed on the ambiguity case.
- `pkg/api/src/agent/match_eval.ts`: shared eval harness for the matching
  agents, in the card_extract eval style (cmd-ts `run`/`score`, plain Bun,
  `evalModel`, `results/<stamp>` + `latest` symlink) but graded as retrieval:
  per-slot tp/fp/fn/tn where a wrong id counts as both fp and fn, with
  per-model precision/recall/accuracy aggregates printed at the end. Fixtures
  are JSON files under each agent's `eval/fixtures/` (a roster or course list
  plus labeled cases); `bun eval:players` / `bun eval:courses` run them.
- `pkg/api/src/model.ts`: all model selection/routing. Models are addressed
  as `ModelSpec` strings of the form `"provider/model@effort"` — reasoning
  effort is part of the model identity, and effort levels are
  provider-defined bare strings (`parseModelSpec` validates the shape and
  throws only on combinations VERIFIED invalid; otherwise fail-open). Specs
  resolve through the AI Gateway's stored BYOK keys, never with a provider
  API key in the repo. `resolveModel(env, model)` is the production
  path via the `env.AI` binding: `openai/*` uses the Responses API through
  the gateway's universal endpoint (gpt-5.4+ reject chat/completions
  `image_url`, and image parts get `detail: "original"` via
  `imageProviderOptionsFor` — openai-only, Google 400s on foreign-namespace
  image-part options); `anthropic/*` and `google/*` use the gateway-delegate's
  `transport: "gateway"` (stored keys, provider-native model ids); `@cf/*`
  natives use the plain `workersai()` call. `evalModel(model)` is the
  local-eval path: the same gateway over public REST with a
  `cf-aig-authorization` token, provider auth headers stripped so the stored
  keys apply. The `openai`/`anthropic`/`google` delegate plugins need their
  `@ai-sdk/*` peers installed — anthropic and google are pinned majors chosen
  for AI SDK v6 spec compatibility; `ai` itself is pinned to the v6 line (not
  v7) because `workers-ai-provider`'s peer range requires it.

## Commands

- `bun dev`: run the Worker (port 8787) and the Vite dev server together via
  `bun run --filter '*' --parallel --elide-lines=0`; develop against the Vite
  URL so `/api` requests proxy through to the Worker with full HMR on the
  front end.
- `bun dev:web`: run only Vite locally; its `/api` requests proxy to the Worker
  (which must already be running separately in another terminal).
- `bun build`: build the Vite app.
- `bun lint`: lint and type-check the repository with Oxlint.
- `bun fmt`: format the repository with Oxfmt.
- `bun test`: run the API's Vitest suite (`pkg/api`) inside the Workers
  runtime via `@cloudflare/vitest-pool-workers`. Includes
  `src/model.test.ts`, which verifies `resolveModel` reaches every model we
  use (the spec list at the top of that file) through the live `env.AI`
  binding — real (tiny, 1px) vision+structured-output calls, so `bun test`
  needs network and costs fractions of a cent. Test files run sequentially
  (`fileParallelism: false`) — the remote AI-binding proxy drops when another
  workerd test file runs in parallel with it.
- `bun db:generate`: generate D1 SQL migrations from the Drizzle schema.
- `bun db:migrate:local` / `bun db:migrate:remote`: apply migrations.
- `nu script/update_seed.nu --local --remote`: upsert the seed data in
  `seed/*.yaml` (golfers + nicknames, courses + sets + holes) into D1. The
  baked-in uuidv7s are CANONICAL for users, nicknames, and courses (upserted
  by id — a pre-existing row with the same unique email under a different id
  fails loudly; align ids first); course sets and holes upsert by natural key
  (course+name, set+number). Re-running is idempotent. Notes: invoke long
  `--command` strings through `./node_modules/.bin/wrangler`, not
  `bunx wrangler` — bunx word-splits quoted arguments; and D1 ignores
  `PRAGMA foreign_keys=OFF`, so drizzle-generated table-recreate migrations
  must have their pragmas rewritten to `PRAGMA defer_foreign_keys = true/false`
  (see migration 0004) or they fail with FOREIGN KEY constraint errors.
- `bun deploy`: builds the front end, then runs `deploy:ci` (remote D1
  migrations + `wrangler deploy`). Workers Builds uses the same scripts —
  build command `bun run build`, deploy command `bun run deploy:ci`,
  non-production (version) command `bunx wrangler versions upload` — so
  migrations only run on production deploys, never on preview builds. These
  three command strings live in the Workers Builds dashboard UI; Cloudflare
  does not read them from wrangler.toml.
- `bun eval run` (or `./eval.ts run` from
  `pkg/api/src/agent/card_extract/eval/`): the extraction eval CLI (cmd-ts) —
  real vision-model calls against the reviewed fixtures in
  `…/card_extract/eval/scorecard/<label>/{image.*,extracted.json}`, for
  iterating on `EXTRACTION_PROMPT`. It's a plain Bun script — no
  wrangler/workerd/vitest. Models resolve via `evalModel`
  (`pkg/api/src/model.ts`): the AI Gateway's provider-native REST endpoints
  authenticated with `AI_GATEWAY_TOKEN` from the repo-root `.env.local`
  (`account_id`/`AI_GATEWAY_ID` come from `wrangler.toml` — single source of
  truth, nothing duplicated into env files).
  `--models provider/model@effort,…` and `--fixtures bhf-01,…` select a
  slice; the default is the gemini-3.5-flash / claude-sonnet-5 /
  gpt-5.6-terra trio at low effort. Cases run 8-way parallel (`p-map`). Each
  case writes `…/eval/results/<YYYY_MM_DD__HH_MM_SS>/<fixture>/
<provider>__<model>__<effort>/{output.json,score.json}` (gitignored), with
  `results/latest` symlinked to the newest run. `run` scores itself when
  extraction finishes; `./eval.ts score [run]` re-grades a past run (default
  `latest`) against the current labels and `score()` criteria without
  re-spending model calls — `score.json` holds a 0–1 `overall` (weighting
  score cells over names over metadata; names compare case-insensitively)
  plus per-category error counts. Fixture images are committed as high-res originals;
  `eval/fixtures.ts` resizes with `sharp` to mirror
  `pkg/web/src/lib/image_resize.ts`'s `resizeImageForCapture` exactly (2048px
  long edge, JPEG quality 80, always re-encoded), so the eval sees the same
  bytes production would actually upload.
- `bun eval:players` / `bun eval:courses`: the matching-agent evals (see
  `match_eval.ts` above) — same `--models`/`--fixtures` flags and
  `run`/`score` subcommands as `bun eval`.

## Schemas

- Always name schemas in upper PascalCase, for example `export const FooBar = z.number()`.
- Always bind each schema's inferred type with the corresponding `Schema` suffix, for example `export type FooSchema = z.infer<typeof FooBar>`.

## Conventions

- Use Oxlint and Oxfmt for linting and formatting; do not add ESLint or Prettier configuration.
- Compose shadcn layouts with `flex flex-col gap-*` containers for vertical rhythm instead of stacking arbitrary `mt-*` utilities. Reserve `mt-auto` for intentional responsive action-bar anchoring.
- Keep `pkg/api/index.ts` as the API composition root. Add route handlers under
  `pkg/api/routes/` and export `AppType` from it so the web RPC client remains
  type-safe. Non-route logic (queue consumers, background processing) belongs
  outside `routes/` — e.g. `pkg/api/src/`.
- Use Drizzle's D1 adapter from `pkg/api/db.ts` for database access; do not use
  raw D1 queries unless there is a concrete reason.
- Never commit Cloudflare credentials or generated `.wrangler` state.
- The repo-root `.env.local` is the ONLY env file — no `.dev.vars`, no other
  `.env*` anywhere. It holds local secrets (`JWT_SECRET` for `wrangler dev`,
  `AI_GATEWAY_TOKEN` for `bun eval`); wrangler dev reads it directly since no
  `.dev.vars` exists. Required Worker secrets are declared in `wrangler.toml`'s
  `[secrets]` block (validated at dev/deploy time); non-secret config belongs
  in `wrangler.toml` itself (`[vars]`, `account_id`), never in env files.
- TanStack Router for the FE.
- API tests live alongside the code they cover (e.g. `pkg/api/routes/*.test.ts`)
  and run with Vitest through `@cloudflare/vitest-pool-workers`, configured in
  `pkg/api/vitest.config.ts` against the root `wrangler.toml`. Bindings a test
  needs but that aren't real secrets (e.g. a test `JWT_SECRET`) are supplied via
  the `miniflare.bindings` option in that config, not `.dev.vars`.
