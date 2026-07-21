# usga_ncrdb_scraper

Standalone CLI that scrapes the [USGA National Course Rating Database](https://ncrdb.usga.org)
(NCRDB) into JSONL, then syncs it into the Scorecard app's **read-only**
`usga_*` tables.

The USGA dump is the source of truth for facilities, course (nine-combination)
listings, and per-tee ratings across the entire United States. The app keeps its
own `course` / `course_set` / `course_set_tee` / `hole` tables (which also track
per-hole pars — data the NCRDB does not publish) and copies USGA values in as
needed; `course_set_tee.usga_tee_id` links an app tee back to the `usga_tee`
row it was derived from.

## Scrape

```sh
bun ncrdb.ts scrape --rps 20 --resume      # full sweep → ./output/*.jsonl
bun ncrdb.ts search "buck hill"            # ad-hoc course search
bun ncrdb.ts describe 12345                # tees for one NCRDB courseID
```

The sweep runs two passes into `./output/` (gitignored), each resumable via
`checkpoint.json`:

- `course.jsonl` — one record per rated course (a nine-combination). Facility
  fields are inlined on every row.
- `tee.jsonl` — one record per tee per course, stamped with its `courseID`.

`ncrdb.test.ts` hits the live endpoints as an integration check (`bun test`).

## Sync into D1

`scripts/sync.ts` upserts the scraped JSONL into the `scorecard` D1 database.
It is the **sole writer** of the `usga_facility` / `usga_course` / `usga_tee`
tables (the app only reads them). Run the schema migration first
(`bun db:migrate:local` / `:remote` from the repo root).

```sh
bun scripts/sync.ts --local                       # from ./output
bun scripts/sync.ts --local --remote              # both databases
bun scripts/sync.ts --remote --dir /path/to/output
```

Flags: `--dir` (JSONL location, default `./output`), `--batch` (rows per
multi-row INSERT, default 10), `--per-file` (INSERT statements per
`wrangler d1 execute` call, default 100 → ~1000 rows per call). Rows upsert by
their natural USGA id, so re-running is idempotent (`created_at` sticks,
`updated_at` refreshes).

### Field placement

`usga_facility` holds only fields that are identical across every course a
facility owns; anything that ever differs between two courses of the same
facility (street address, city, legacy id) lives on `usga_course`, so no varying
value is lost. `usga_tee` flattens the front-nine/back-nine rating splits into
`front9_*` / `back9_*` columns.
