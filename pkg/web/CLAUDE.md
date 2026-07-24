# pkg/web — front-end conventions

Front-end-specific guidance. The **repo-root `CLAUDE.md`** holds the app
architecture (routes, pages, the API/RPC contract, capture/review flow); this
file is the "how we build UI here" layer. Read both.

Stack: Vite + React 19 + TypeScript, TanStack Router, **TanStack Query** (with
`hono-rpc-query`), Tailwind v4, shadcn/ui on top of **Base UI**
(`@base-ui/react` — NOT Radix; props/APIs differ, e.g. `render={<Comp/>}` slots,
`initialFocus`, `Positioner`), `cmdk` for command lists, `recharts` for charts.

## Data fetching: TanStack Query only

**Never fetch in a `useEffect`.** No `useState` for server data, no hand-rolled
loading/error flags, no `cancelled` flags. Every request — reads, writes, polls
— goes through TanStack Query. `useEffect` is for DOM/timer/URL side effects
only (revoking an object URL, a debounce timer, a progress interval).

`src/lib/api.ts` exports `api`: the Hono RPC client wrapped in
`hono-rpc-query`'s `hcQuery`. `src/lib/query.ts` adapts it — its wrappers exist
because the library's own `queryFn` never checks `response.ok`, which would turn
a 404 into data:

```tsx
const golfer = useQuery(apiQuery(api.golfers[":id"].$get, { param: { id } }));
//  → { queryKey, queryFn } — spread it to add options:
const self = useQuery({ ...apiQuery(api.me.$get), enabled: signedIn });

const save = useMutation({
  ...apiMutation(api.golfers[":id"].$patch),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: apiQueryKey(api.golfers.$get) }),
});
save.mutate({ param: { id }, json: { name } }); // typed from the route

const list = useInfiniteQuery(apiInfiniteQuery(api.outings.$get, { query: { limit: 20 } }));
const outings = pagedRecords(list.data); // null while the first page is in flight
<LoadMore
  hasMore={list.hasNextPage}
  loading={list.isFetchingNextPage}
  onLoadMore={() => void list.fetchNextPage()}
/>;
```

- Errors: a non-2xx throws `ApiError` (the API's own `error` message, plus
  `status`), so read `query.error?.message` / `mutation.error?.message` instead
  of parsing bodies. `apiQueryKey(endpoint)` with no input is a prefix that
  invalidates every variant of that endpoint (all filters, all pages).
- Filters/search belong in the query KEY (pass them as `input`), so changing one
  starts a fresh list and the old one stays cached. Debounce a text input into
  the state you pass as input; don't debounce the fetch.
- Shared factories live in `src/lib/queries.ts`: `allCoursesQuery()` /
  `allGolfersQuery()` walk every page for the comboboxes that filter the whole
  registry client-side; `scorecardImageQuery(id)` fetches a photo as an object
  URL (the endpoint needs the bearer token, so `<img src>` can't); the job polls
  (`scorecardScoresQuery`, `scorecardMetadataQuery`, `courseResearchQuery`) use
  `refetchInterval` while the body says `status: "pending"` — check with
  `isPending(data)` — until a per-attempt deadline.
- Sequencing without effects: gate a dependent query with `enabled` (see the
  course-import flow, where the research PUT is a `staleTime: Infinity` query
  that fires once its inputs are ready), and derive wizard steps from the data
  rather than setting state when a fetch lands.
- Multipart uploads have no typed RPC method (the route parses the form itself),
  so they're a `useMutation` with a hand-written `fetch` — still a mutation.

## Reuse these components — don't reinvent

Before adding a picker/modal/score cell, use the shared component. There is one
canonical component per job:

- **Every single-select → `ResponsiveSelect`** (`@/components/responsive-select`).
  This is THE select. The raw Base UI `Select` primitive has been removed
  (`ui/select.tsx` is gone) — do not re-add it. `ResponsiveSelect` renders an
  anchored **popover on desktop** and a **bottom sheet on phones**, which is
  both nicer on mobile and dodges two Base UI popup bugs there (a portaled
  popover's autofocused search box jumps the page scroll; touch on a tightly
  anchored Select popup misfires). It's generic over the option value type.
- **Multi-value (chips-in-input) → `MultiCombobox`** (`@/components/multi-combobox`,
  used for nickname editing). Different UX from a single-select; keep it separate.
- **Dialogs / forms → `ResponsiveModal`** (`@/components/responsive-modal`):
  centered dialog on desktop, bottom sheet on mobile. It locks the shape once at
  open time (so the exit animation doesn't morph). Use for every app modal.
- **Score cells → `GolfScore`** (`@/components/golf-score`): standard golf
  notation (birdie circle, bogey square…), read-only by default, editable with
  `onChange`.
- **The footer of a paginated list → `LoadMore`** (`@/components/load-more`):
  the full-width "Load more" row, wired to an infinite query. It renders nothing
  when `hasMore` is false, so it can sit unconditionally at the end of a card.

`ResponsiveSelect` and `ResponsiveModal` share the 640px (`sm:`) breakpoint so
the whole app's popovers/sheets feel like one system.

## ResponsiveSelect cheat-sheet

```tsx
<ResponsiveSelect
  value={value} // T | null  (null = nothing selected)
  onValueChange={setValue} // (T | null) => void
  options={items.map((x) => ({ value: x.id, label: x.name }))} // or null = loading
  // — turn features on as the case needs —
  searchable // client-side filter box (label + keywords)
  clearable
  placeholder="All courses" // adds a null row; null shows the placeholder
  invalid={value === null} // red ring when a required pick is empty
  ariaLabel="Course" // accessible name when there's no <Label htmlFor>
  title="Filter by course" // mobile sheet header (defaults to placeholder)
/>
```

Decide per call site:

| Need                                  | Prop                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Long list (golfers, courses, players) | `searchable`                                                                                                                               |
| Server-side search (query → fetch)    | `onSearch` (disables the client filter; parent supplies filtered `options`)                                                                |
| Async options loaded on open          | `options={loaded ? [...] : null}` + `onOpen` (spinner while null)                                                                          |
| A "none" / "All X" choice             | `clearable` + set `placeholder` to the null text                                                                                           |
| Custom row (extra info, badges)       | `renderItem={(opt,{selected}) => …}` (trigger still shows `label`; see the nine picker in `review-round.tsx` for the muted-suffix pattern) |
| Custom trigger text                   | `renderValue={(opt) => …}`                                                                                                                 |
| Extra filter terms beyond the label   | `option.keywords`                                                                                                                          |
| No visible label                      | `ariaLabel` (else associate a `<Label htmlFor={id}>`)                                                                                      |

Options are `{ value, label, description?, keywords?, disabled? }`. `description`
renders as a muted second line in the default row. Prefer stable ids as `value`
and let the label/keywords drive filtering (never a label-as-value).

## Non-obvious gotchas

- **`process.env.NODE_ENV`**: fine to use — Vite statically replaces it, so a
  `process.env.NODE_ENV === "development"` guard is dead-code-eliminated from
  prod bundles (that's how the dev-login UI in `login.tsx` stays out of prod).
  But the web tsconfig has no Node types, and **it type-checks the API sources
  it imports** (the RPC `AppType` graph). `src/vite-env.d.ts` declares a minimal
  ambient `process` so both the web and any imported API file that reads
  `process.env` compile. Keep API code portable to both tsconfigs — don't reach
  for other Node globals in code the web imports.
- **Import only TYPES from the `api` package** (`import type { Tee } from "api"`).
  Importing a value pulls the Worker module graph into the web bundle. Mirrors
  of API constants live in `src/lib/*` (e.g. `lib/tees.ts`) for this reason.
- **RPC path mapping**: Hono maps URL segments to client props; a hyphenated
  route is bracket-indexed — `POST /api/auth/dev-login` →
  `client.api.auth["dev-login"].$post(...)`.
- **Routing** (TanStack): navigate with typed `Link` / `useNavigate`; validate
  search params with a `validateSearch` zod schema in the route; only use
  `navigate({ href })` for runtime-validated paths (e.g. login `returnTo`), never
  `window.location`. Route-level auth via `checkAuth()` (see `lib/auth.ts`), not
  in-component redirects.
- **Base UI, not Radix**: triggers take a `render={<Button/>}` slot with the
  content as children; portaled popups use `Portal` + `Positioner`; dialogs
  accept `initialFocus`/`finalFocus`. Don't copy Radix patterns.

## Styling

- Tailwind v4 + shadcn tokens. Compose vertical rhythm with
  `flex flex-col gap-*` containers, not stacked `mt-*`. Reserve `mt-auto` for
  intentional action-bar anchoring.
- Theme-aware by default (light/dark via tokens); only hard-code colors for
  deliberately theme-independent UI (e.g. the `<CautionStripe>` hazard frame).
- Button icons use the `data-icon="inline-start" | "inline-end"` convention.

## Commands (from repo root)

- `bun dev` / `bun dev:tunnel` — dev servers (± an ngrok tunnel for phones).
  See root CLAUDE.md.
- `bun run build` — `tsr generate && tsc -b && vite build`. `tsc` here compiles
  the imported API sources too, so a type error in `pkg/api` can fail the web
  build; fix it portably rather than isolating the packages.
- `bun lint` — Oxlint, type-aware. `bun fmt` — Oxfmt. No ESLint/Prettier.
