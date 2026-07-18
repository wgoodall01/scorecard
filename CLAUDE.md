# Scorecard

Scorecard ingests golf-scorecard images, stores them in R2, extracts round data,
matches it against the database (players, courses), and records outings and
scores that the app browses and will use for golf metrics, prizes, and awards.

## Architecture

- `pkg/web`: Vite + React + TypeScript front end, styled with Tailwind and
  shadcn/ui. `src/lib/api.ts` creates Hono's typed RPC client from the API's
  exported `AppType`. `src/App.tsx` is the app shell ONLY (AppShell, nav,
  PageHeading/PageTitle); every page component lives in `src/pages/`
  (capture, login, me, golfers, outings, courses, honors, scorecards — the
  scorecards list/detail pages are deliberately NOT nav tabs; the Me page
  shows the 5 most recent with a "Show more" link, and the detail page
  links to the outings whose scores came from the card); routes under
  `src/routes` are thin `createFileRoute` wrappers (capture lives at
  `/capture`; the root `/` is only a redirect to it). Router rules: navigate
  with typed `Link`/`useNavigate` (`LinkProps["to"]` for nav helpers), use
  `navigate({ href })` only for runtime-validated paths like the login
  `returnTo` — never `window.location.assign`; search params go through
  `validateSearch` zod schemas; the router sets `defaultPreload: "intent"`
  and `scrollRestoration` in `src/router.tsx`. Import only TYPES from the `api`
  package (`Tee`, `ExtractDataSchema`, …) — importing a value would pull the
  Worker module graph into the web bundle (`src/lib/tees.ts` mirrors the
  `TEES` list for this reason). The capture review step
  (`src/components/review-round.tsx`) is the mobile-first editor over the
  extraction: score grid, golfer pickers seeded from `matched`, an
  async-loading course combobox
  (`src/components/async-combobox.tsx`, re-fetched on every open) over
  existing courses, a date input defaulting to the handwritten date else
  today (future dates are flagged and a "Today" button resolves them; the
  API also rejects them), and the `/outings/check`-driven "add to existing
  outing" prompt, which lists any existing scores the merge would overwrite
  (per golfer, "Blue 1–9"-style); submit POSTs `/outings` (with the
  capture's `scorecardId`) and links to `/outings/$id`. It is TWO sub-steps:
  date/course/golfers first, then per-nine review (which shows matched
  golfers' FULL names, not the written scrawl; two written names MAY map to
  one golfer — cards sometimes alias a person per nine — but not within a
  single nine) — each nine is assigned to an
  EXISTING course set only (there is NO course create/edit surface anywhere,
  API or UI; course data is imported directly into the database — seed
  script, ratings scraper — and the Courses tab is a read-only registry)
  with a
  per-golfer TEE picker over the set's `course_set_tee` rows (auto-defaulted
  from a merge candidate's recorded tee, else the golfer's `preferredTee`
  TYPE, else the standard-type tee), pars display from the db tee (score
  notation judges each cell against the tee its player hit from), and
  before submit every handwritten total (per
  nine and the 18-hole totals) is checked: totals that matched the summed
  scores at extraction auto-confirm and render checkmarks only, while
  mismatches require an explicit ruling — written totals are wrong / I
  corrected a score. The Courses tab (`src/pages/courses.tsx`) lists
  courses and shows each course's nines with hole/par tables. The outing
  detail page auto-suggests same-day-same-course outings and can merge them
  via `/outings/:id/merge`; its Golfers card is a leaderboard (sorted
  ascending, a lucide Trophy on the winning complete round, ties share).
  Score cells everywhere render through
  `src/components/golf-score.tsx` — standard golf notation (circle birdie,
  double circle eagle+, square bogey, double square double+), read-only by
  default, editable with `onChange` (the review grid). Golfer nickname
  editing uses `src/components/multi-combobox.tsx`, a chips-in-one-input
  wrapper over the stock shadcn/Base UI `ui/combobox.tsx` in `multiple` mode
  with creatable free-text entries.
- `pkg/api`: Cloudflare Worker written with Hono + TypeScript. `index.ts` is
  the composition root; its default export is `{ fetch, queue }` and
  `POST /api/ping` responds with `{ time: Date }`.
- `wrangler.toml`: deployment configuration at the repository root. It serves
  `pkg/web/dist` as SPA assets, runs the Worker first for `/api/*`, and binds
  `DB` to the `scorecard` D1 database, `BUCKET` to the `scorecard` R2 bucket,
  and `IMAGES` to Cloudflare Images transforms.
- `pkg/api/schema.ts`: Drizzle schema (with `relations` for the relational
  query API). Tables: `user` (+ `handicap`, `preferred_tee` — the `TEES`
  const is the app-level tee CATEGORY list, matched against
  `course_set_tee.type`; `email` is NULLABLE-but-unique: a golfer can exist
  purely as a player with no account email, and can't sign in until one is
  set), `nickname` (user_id, nickname, nickname_type; a case-insensitive
  expression index makes nicknames unique per user, and the golfers routes
  reject duplicate lists at the request edge),
  `course`, `course_set` (a "nine"; name unique per course; NO stored
  front/back disposition — derive it from hole numbers where the UI needs
  it, which keeps sets nonoverlapping; USGA provenance is
  `usga_course_id` + `usga_course_nine` front/back/null, i.e. "this nine is
  the front/back half of THIS rated 18-hole course"), `course_set_tee` (a
  real tee position on a nine: printed
  `name` like "Blue", `gender` m/f/null, nullable `type` from `TEES` for
  matching profile preferences — untyped tees are still playable — and
  nullable 9-hole `course_rating`/`slope_rating`, null = unrated; unique per
  (set, lower(name), coalesce(gender, ''))), `hole` (belongs to a TEE, not
  the set — par can differ by tee; number unique per tee), `outing` (naive
  `date` "YYYY-MM-DD" + course_id), `score_set` (the root of scores: one row
  per (outing, player, course_set_tee), so a day can mix tees nine-by-nine
  and every score commits to a tee), `scorecard` (one row per captured card,
  created at upload and tagged `user_id`; its id IS the capture id — the
  photo lives in R2 at cards/<id>/image, but the scores-extraction result
  lives on the row in `scores_extract`, an unindexed `json` column holding
  `{extracted, matched}`, with `scores_error` for failures — status derives
  from those two columns), and `score` (score_set/hole unique, with a
  nullable `scorecard_id` recording which captured card each score was read
  from). EVERY table carries `created_at`/`updated_at` ISO-8601 audit
  columns, maintained by drizzle `$defaultFn`/`$onUpdateFn` — app-level, so
  raw-SQL writers (the seed script, tests that care) must set them
  themselves. Generated SQL migrations belong in `pkg/api/migrations` and
  are applied by Wrangler.
- `pkg/api/routes/golfers.ts`: the player registry (subsumes the old admin
  routes/page). List/get golfers with nicknames (any signed-in user); PATCH is
  self-or-admin (nicknames use replace-all semantics; the `admin` flag needs an
  admin and never on yourself); `/golfers/invite` is admin-only and sends the
  invite email. The web's Golfers tab drives all of this — there is no
  separate admin UI; controls are shown by permission checks.
- `pkg/api/routes/outings.ts`: `/courses` (with sets, their TEES, and each
  tee's holes — the review UI shows database pars and auto-picks sets by par
  sequence against any tee's layout);
  `/outings` list (reverse-chrono summaries; course/set/player filters);
  `/outings/check` (merge-candidate lookup: an outing on the same date with
  scores on any of the given course sets — the one-foursome-two-scorecards
  case); `/outings/:id` detail (sets derived from score_sets, a display hole
  layout, per-player tees and per-player pars, score cell maps keyed by hole
  NUMBER — two players on one nine may have played different tees whose
  holes are distinct rows — plus the distinct `scorecards` behind those
  scores); POST `/outings` submits a reviewed capture — every player entry
  names the `courseSetTeeId` they played each nine from (score rows resolve
  hole ids through that tee), it rejects future dates ("today" judged at
  UTC+14 so no honest local today loses; merges exempt), records
  `scorecardId` on every score row, references EXISTING courses, sets, and
  tees only (there is no API to create or edit course data — it's imported
  directly into the database), merges into an existing outing via `outingId`
  (existing score_sets are preloaded so scores upsert into them), and writes
  all rows through one `db.batch`;
  POST `/outings/:id/merge` merges an already-recorded same-date-same-course
  outing into `:id` (score sets move to the target; the target wins when
  both have a score for the same player, course set, and hole number even
  across different tees; source sets duplicating a target (player, tee) pour
  into it; emptied sets and the source outing are deleted).
- `pkg/api/src/handicap.ts`: the WHS (2024 Rules of Handicapping) Handicap
  Index. One raw-D1 query pulls every scored hole with its nine's ratings;
  `handicapFromRounds` (pure, unit-tested) replays the record
  chronologically — differentials (18-hole = two nines' ratings summed,
  slopes averaged; 9-hole via the expected-differential formula
  `0.52·HI + 1.2`), net double bogey (stroke allocation proxied by par-desc
  since holes carry no stroke index), best-8-of-20 / fewer-scores table, ESR,
  and soft/hard caps vs the 365-day Low Index. House rules: the table
  extends down to 1–2 differentials flagged `provisional` (UI copy: "not
  enough scores for a traditional handicap, provisional shown instead"), a
  first-ever 9-hole score doubles its differential, PCC = 0.
  `GET /golfers/:id/handicap` (in routes/golfers.ts) returns
  `PlayerHandicap`: current index, provisional flag, and a timeseries of
  USGA-standard ROUNDS (an outing posts one 18-hole round per pair of
  complete rated nines plus a 9-hole round for a leftover — a 27-hole
  outing is two points), each with its nines, gross strokes, differential,
  the index after it, and `counted` (whether the current index averages
  it). The golfer page charts the timeseries (recharts + `ui/chart.tsx`;
  UI calls the computed feature "Casual Handicap" — it's an estimate —
  never "Handicap Index"; the profile's manually entered `handicap` field
  stays plain "Handicap") and its outing list shows
  per-round scores with a star on counted rounds. Ratings live ON the
  `course_set_tee` row (nullable 9-hole `course_rating`/`slope_rating`;
  null = unrated, the nine can't post) — no tee resolution: every score
  hangs off a score_set that names its tee, and nines group by (outing,
  tee), so a mixed-tee 18 combines each tee's own ratings. USGA NCRDB
  provenance ids live on `course.ncrdb_facility_id` and
  `course_set.usga_course_id` + `usga_course_nine` (which rated 18-hole
  combo the nine is half of, and which half — every seeded nine fronts its
  combo, so `front`; linked from the course page, which shows each nine's
  Par row from the men's-standard baseline tee and its tees table with
  per-tee ratings plus a rightmost par-exceptions column — "Hole 4 is Par
  4"-style deviations from that baseline). Buck Hill
  Falls is seeded in
  `seed/courses.yaml` from NCRDB CourseIDs 21162/21163/21164 (facility
  20114): men's marker tees Blue/White/Gold/Red/Green typed as
  back/standard/senior/front/junior (BHF has no tips). Every seed tee
  carries its own `holes` list with hardcoded uuidv7 ids (pars differ by
  tee on some holes — exact per-tee pars/ratings will be re-upserted by a
  planned USGA scraper).
- `pkg/api/routes/honors.ts` + `pkg/api/src/honors.ts`: the honors board.
  `computeHonors(db, since)` runs ONE SQLite query (CTEs + window functions;
  raw D1, deliberately not Drizzle) over the recent window
  (`HONOR_WINDOW_DAYS`, 90 days). The query emits a single row with one
  `json_object` column per honor slug (NULL = unawarded) — scalar-subquery
  columns rather than a UNION ALL arm per honor because D1 caps
  compound-SELECT terms — and the app code is a bind + JSON.parse into the
  `Honor` discriminated union (medalist, hot-nine, birdie-machine,
  par-machine, metronome, iron-golfer, comeback-kid, crater, snowman,
  anchor). One holder per honor; tie-breaks favor the most recent
  achievement; rate honors need ≥18 holes in the window; the anchor needs
  ≥2 eligible players. `GET /honors` recomputes on every request.
  `src/honors.test.ts` seeds the test D1 and asserts the board. The web's
  Honors tab (`pkg/web/src/pages/honors.tsx`) renders every slug — claimed
  cards get per-honor custom stat/story UI, unclaimed ones a dimmed
  placeholder.
- `pkg/api/routes/scorecard.ts`: routes only — POST `/scorecard` uploads the
  image to R2, inserts the user-tagged scorecard row, and enqueues a
  `CAPTURE_QUEUE` message per requested extraction (the multipart `extract`
  field is JSON like `{"scores": true}`; a course-metadata pars/yardages
  extraction will join it); GET `/scorecard/:id/scores` is the owner-only
  status/result poll (202 pending / `{extracted, matched}` / 500 with the
  error); GET `/scorecard` lists the signed-in user's cards newest-first
  (`?limit=`); GET `/scorecard/:id` is the league-visible detail (status,
  uploader, and the outings whose scores were read from the card); GET
  `/scorecard/:id/image` streams the photo. Exports `scorecardImageKey` and
  `scorecardStatus` for the agent module below.
- `pkg/api/src/agent/card_extract/`: the extraction agent. `agent.ts` exports
  `extractScorecard({image, resolver, model})` — one `generateObject` call
  with vision input — plus `handleCaptureQueue` (wired into `index.ts`'s
  `queue` handler), which reads the uploaded image from R2, normalizes it via
  the `IMAGES` binding (scale-down to 2048px-long-edge JPEG q80, passing
  already-conforming JPEGs through without re-encoding — the route stores raw
  uploaded bytes, size-limited only) and extracts. `schema.ts` defines ONE
  schema, `ExtractData` — what the model emits, what the agent returns,
  what's stored in `scores_extract`, and what the eval fixtures assert;
  there is no wire/public split (it also hosts the `MatchedData` /
  `ScoresExtractData` types so the db schema can reference them without a
  module cycle). Per-player data is
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
  against `env.DB`, then stores `{extracted, matched}` on the scorecard
  row's `scores_extract` column (failures set `scores_error`) — nothing but
  the image lives in R2; matching is best-effort — any failure, including
  429s, degrades to nulls rather than failing or retrying the capture,
  since retrying would re-spend the far more expensive vision call and the
  review UI lets the user pick manually.
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
  workerd test file runs in parallel with it. A setup file
  (`pkg/api/test/apply-migrations.ts`) applies the D1 migrations to the test
  database (read in `vitest.config.ts`, passed via the `TEST_MIGRATIONS`
  binding); test D1 storage persists across tests, so DB-touching test files
  wipe their tables in a `beforeEach`.
- `bun db:generate`: generate D1 SQL migrations from the Drizzle schema.
- `bun db:migrate:local` / `bun db:migrate:remote`: apply migrations.
- `nu script/update_seed.nu --local --remote`: upsert the seed data in
  `seed/*.yaml` (golfers + nicknames, courses + sets + tees + holes) into
  D1. The baked-in uuidv7s are CANONICAL for users, nicknames, and courses
  (upserted by id — a pre-existing row with the same unique email under a
  different id fails loudly; align ids first); course sets, tees, and holes
  upsert by natural key (course+name, set+lower(name)+gender, tee+number).
  EVERY row's id is hardcoded in the YAML and only sticks on first insert. Re-running is idempotent. Notes: invoke long
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
