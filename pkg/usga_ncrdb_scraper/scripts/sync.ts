#!/usr/bin/env bun
// Upsert the scraped USGA NCRDB JSONL into the app's read-only usga_* tables.
//
//   bun scripts/sync.ts --local
//   bun scripts/sync.ts --local --remote
//   bun scripts/sync.ts --remote --dir /path/to/output
//
// Reads course.jsonl and tee.jsonl (produced by `bun ncrdb.ts scrape`) and
// upserts them into the scorecard D1 database's usga_facility / usga_course /
// usga_tee tables. Those three tables are WHOLLY OWNED by this scraper — the app
// only ever reads them — so this is the sole writer.
//
// Rows upsert by their natural USGA id (facility_id / course_id / tee_id via
// ON CONFLICT DO UPDATE), so re-running is idempotent and refreshes changed
// rows. Field placement mirrors the schema: facility-level fields that are
// constant across all of a facility's courses live on usga_facility; anything
// that varies per course (street address, city, legacy id) lives on usga_course.
//
// Loading is batched: rows are packed into multi-row INSERT statements
// (--batch rows each) and those statements are grouped into files
// (--per-file statements each) run through one `wrangler d1 execute --file`
// call apiece, keeping every request comfortably bounded (there are ~12k
// facilities, ~14k courses, ~125k tees).

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// SQL-quote ANY value as a string literal, mapping null to NULL. Single
// quotes are doubled ('') — the only escaping SQLite string literals need
// (unlike MySQL, SQLite gives backslash no special meaning), so this makes an
// arbitrary value safe to interpolate. Every text column goes through this.
function sq(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

// Render a value destined for a NUMERIC column as a bare SQL literal. A bare
// (unquoted) literal is only safe if it is genuinely a number, so this REFUSES
// anything that isn't a finite number (null → NULL). That guarantees nothing
// but a validated number is ever emitted unquoted; a malformed source value
// aborts the whole run (this all happens while building statements, before any
// DB write) instead of silently corrupting data or breaking out of the
// statement.
function numlit(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `expected a number for a numeric column, got ${typeof value}: ${JSON.stringify(value)}`,
    );
  }
  return String(value);
}

// ISO-8601 "now" for the created_at/updated_at audit columns — raw-SQL inserts
// bypass drizzle's app-level defaults, so the sync sets them itself (created_at
// sticks from first insert; updated_at refreshes on every upsert).
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function run(cmd: string[], cwd?: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    throw new Error(`command failed: ${cmd.join(" ")}`);
  }
}

// Ensure a .jsonl exists, decompressing its committed .jsonl.zst snapshot if the
// raw file is absent (the .zst is kept). Needs the `zstd` CLI on PATH.
async function ensureJsonl(file: string) {
  if (existsSync(file)) return;
  const zst = `${file}.zst`;
  if (existsSync(zst)) {
    console.log(`Decompressing ${path.basename(zst)}…`);
    await run(["zstd", "-d", "-k", "-f", "-o", file, zst]);
  }
}

// Read a JSONL file into an array of records (one object per non-blank line).
async function readJsonl(file: string): Promise<any[]> {
  const text = await Bun.file(file).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Pack already-rendered "(v1, v2, …)" value-tuple strings into multi-row
// "INSERT INTO … VALUES … ON CONFLICT …" statements, `batch` rows each.
function buildInserts(tuples: string[], prefix: string, suffix: string, batch: number): string[] {
  return chunks(tuples, batch).map((group) => `${prefix}${group.join(", ")} ${suffix};`);
}

const { values: flags } = parseArgs({
  options: {
    local: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    dir: { type: "string" },
    batch: { type: "string", default: "50" },
    "per-file": { type: "string", default: "500" },
  },
});
if (!flags.local && !flags.remote) {
  console.error("Pass --local and/or --remote.");
  process.exit(1);
}
const batch = Number(flags.batch);
const perFile = Number(flags["per-file"]);

const pkg = path.dirname(import.meta.dir);
const root = path.dirname(path.dirname(pkg));
const out = flags.dir ?? path.join(pkg, "output");
const coursePath = path.join(out, "course.jsonl");
const teePath = path.join(out, "tee.jsonl");

// Group statements into files and run each file through wrangler d1 execute for
// every requested target, from the repo root (where wrangler.toml and
// node_modules/.bin/wrangler live).
async function applyStatements(statements: string[]) {
  const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
  const files = chunks(statements, perFile);
  for (const [index, group] of files.entries()) {
    const tmp = path.join(tmpdir(), `usga-sync-${crypto.randomUUID()}.sql`);
    await Bun.write(tmp, group.join("\n") + "\n");
    try {
      if (flags.local) {
        console.log(`    file ${index + 1}/${files.length} → local`);
        await run(
          [
            wrangler,
            "d1",
            "execute",
            "scorecard",
            "--local",
            "--config",
            "wrangler.toml",
            "--file",
            tmp,
          ],
          root,
        );
      }
      if (flags.remote) {
        console.log(`    file ${index + 1}/${files.length} → remote`);
        await run(
          [
            wrangler,
            "d1",
            "execute",
            "scorecard",
            "--remote",
            "--yes",
            "--config",
            "wrangler.toml",
            "--file",
            tmp,
          ],
          root,
        );
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

// Fall back to the committed .jsonl.zst snapshots when the raw JSONL is absent.
await ensureJsonl(coursePath);
await ensureJsonl(teePath);

for (const p of [coursePath, teePath]) {
  if (!existsSync(p)) {
    console.error(
      `Missing ${p} (and no ${p}.zst). Run \`bun ncrdb.ts scrape\` first, or pass --dir.`,
    );
    process.exit(1);
  }
}

// usga_* tables carry no foreign keys between them, so load order is free.
const courses = await readJsonl(coursePath);

console.log(`Facilities: deduping ${courses.length} course rows by facility…`);
// First occurrence wins (matching nu's uniq-by).
const facilityById = new Map<number, any>();
for (const c of courses) if (!facilityById.has(c.facilityID)) facilityById.set(c.facilityID, c);
const facilities = [...facilityById.values()];
const facilityTuples = facilities.map(
  (c) =>
    "(" +
    [
      numlit(c.facilityID),
      sq(c.facilityName),
      sq(c.state),
      sq(c.country),
      numlit(c.entCountryCode),
      numlit(c.entStateCode),
      sq(c.telephone),
      sq(c.email),
      sq(c.stateDisplay),
      NOW_SQL,
      NOW_SQL,
    ].join(", ") +
    ")",
);
const facilitySql = buildInserts(
  facilityTuples,
  "INSERT INTO usga_facility (facility_id, name, state, country, ent_country_code, ent_state_code, telephone, email, state_display, created_at, updated_at) VALUES ",
  "ON CONFLICT(facility_id) DO UPDATE SET name=excluded.name, state=excluded.state, " +
    "country=excluded.country, ent_country_code=excluded.ent_country_code, " +
    "ent_state_code=excluded.ent_state_code, telephone=excluded.telephone, " +
    "email=excluded.email, state_display=excluded.state_display, updated_at=excluded.updated_at",
  batch,
);

console.log(`Courses: ${courses.length} rows…`);
const courseTuples = courses.map(
  (c) =>
    "(" +
    [
      numlit(c.courseID),
      numlit(c.facilityID),
      sq(c.courseName),
      sq(c.fullName),
      sq(c.address1),
      sq(c.address2),
      sq(c.city),
      numlit(c.legacyCRPCourseId),
      NOW_SQL,
      NOW_SQL,
    ].join(", ") +
    ")",
);
const courseSql = buildInserts(
  courseTuples,
  "INSERT INTO usga_course (course_id, facility_id, name, full_name, address1, address2, city, legacy_crp_course_id, created_at, updated_at) VALUES ",
  "ON CONFLICT(course_id) DO UPDATE SET facility_id=excluded.facility_id, name=excluded.name, " +
    "full_name=excluded.full_name, address1=excluded.address1, address2=excluded.address2, " +
    "city=excluded.city, legacy_crp_course_id=excluded.legacy_crp_course_id, updated_at=excluded.updated_at",
  batch,
);

console.log("Tees: reading tee.jsonl…");
const tees = await readJsonl(teePath);
console.log(`Tees: ${tees.length} rows…`);
const teeTuples = tees.map(
  (t) =>
    "(" +
    [
      numlit(t.teeId),
      numlit(t.courseID),
      sq(t.teeName),
      sq(t.gender),
      numlit(t.par),
      numlit(t.courseRating),
      numlit(t.bogeyRating),
      numlit(t.slopeRating),
      numlit(t.length),
      numlit(t.front9.courseRating),
      numlit(t.front9.slopeRating),
      numlit(t.back9.courseRating),
      numlit(t.back9.slopeRating),
      NOW_SQL,
      NOW_SQL,
    ].join(", ") +
    ")",
);
const teeSql = buildInserts(
  teeTuples,
  "INSERT INTO usga_tee (tee_id, course_id, name, gender, par, course_rating, bogey_rating, slope_rating, length, front9_course_rating, front9_slope_rating, back9_course_rating, back9_slope_rating, created_at, updated_at) VALUES ",
  "ON CONFLICT(tee_id) DO UPDATE SET course_id=excluded.course_id, name=excluded.name, " +
    "gender=excluded.gender, par=excluded.par, course_rating=excluded.course_rating, " +
    "bogey_rating=excluded.bogey_rating, slope_rating=excluded.slope_rating, length=excluded.length, " +
    "front9_course_rating=excluded.front9_course_rating, front9_slope_rating=excluded.front9_slope_rating, " +
    "back9_course_rating=excluded.back9_course_rating, back9_slope_rating=excluded.back9_slope_rating, " +
    "updated_at=excluded.updated_at",
  batch,
);

console.log(`\nusga_facility: ${facilitySql.length} batches`);
await applyStatements(facilitySql);
console.log(`usga_course: ${courseSql.length} batches`);
await applyStatements(courseSql);
console.log(`usga_tee: ${teeSql.length} batches`);
await applyStatements(teeSql);
console.log("Done.");
