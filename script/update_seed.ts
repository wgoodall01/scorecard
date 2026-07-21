#!/usr/bin/env bun
// Upsert the YAML seed data in seed/ into the scorecard D1 database(s).
//
//   bun script/update_seed.ts --local
//   bun script/update_seed.ts --local --remote
//
// Users, nicknames, and courses upsert by ID — the uuidv7s baked into the
// YAML files are canonical (foreign keys point at them), and user emails may
// be null. A pre-existing user row whose email collides with a seeded one
// under a different id fails loudly on the unique email index; align the ids
// first. Course sets, tees, and holes upsert by their natural keys —
// (course_id, name), (course_set_id, lower(name), coalesce(gender, '')), and
// (course_set_tee_id, number) — so hand-created rows with the same natural
// key keep their ids; every row's id is hardcoded in the YAML and is only
// used on first insert.

import { parseArgs } from "node:util";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// SQL-quote a value, mapping null/undefined to NULL.
function sq(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

// A numeric column: pass through as a bare literal, null/undefined as NULL.
function num(value: unknown): string {
  return value === null || value === undefined ? "NULL" : String(value);
}

// ISO-8601 "now" for the created_at/updated_at audit columns — raw-SQL
// inserts bypass drizzle's app-level defaults, so the seed sets them itself
// (created_at sticks from first insert; updated_at refreshes on every upsert).
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

type Nickname = { id: string; nickname: string; type: string };
type Golfer = {
  id: string;
  email: string | null;
  name: string;
  admin: boolean;
  nicknames?: Nickname[];
};
type Hole = { id: string; number: number; par: number; yardage?: number };
type Tee = {
  id: string;
  name: string;
  gender?: string | null;
  type?: string | null;
  course_rating?: number | null;
  slope_rating?: number | null;
  holes?: Hole[];
};
type CourseSet = {
  id: string;
  name: string;
  usga_course_id?: number | null;
  usga_course_nine?: string | null;
  tees?: Tee[];
};
type Course = {
  id: string;
  name: string;
  location?: string | null;
  ncrdb_facility_id?: number | null;
  sets?: CourseSet[];
};

async function golferStatements(root: string): Promise<string[]> {
  const doc = Bun.YAML.parse(await Bun.file(path.join(root, "seed", "golfers.yaml")).text()) as {
    golfers: Golfer[];
  };
  return doc.golfers.flatMap((golfer) => [
    `INSERT INTO user (id, email, name, admin, created_at, updated_at) VALUES (` +
      [
        sq(golfer.id),
        sq(golfer.email ?? null),
        sq(golfer.name),
        golfer.admin ? "1" : "0",
        NOW_SQL,
        NOW_SQL,
      ].join(", ") +
      `) ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, ` +
      `admin=excluded.admin, updated_at=excluded.updated_at;`,
    ...(golfer.nicknames ?? []).map(
      (nick) =>
        `INSERT INTO nickname (id, user_id, nickname, nickname_type, created_at, updated_at) VALUES (` +
        [sq(nick.id), sq(golfer.id), sq(nick.nickname), sq(nick.type), NOW_SQL, NOW_SQL].join(
          ", ",
        ) +
        `) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, ` +
        `nickname=excluded.nickname, nickname_type=excluded.nickname_type, updated_at=excluded.updated_at;`,
    ),
  ]);
}

async function courseStatements(root: string): Promise<string[]> {
  const doc = Bun.YAML.parse(await Bun.file(path.join(root, "seed", "courses.yaml")).text()) as {
    courses: Course[];
  };
  return doc.courses.flatMap((course) => [
    `INSERT INTO course (id, name, location, ncrdb_facility_id, created_at, updated_at) VALUES (` +
      [
        sq(course.id),
        sq(course.name),
        sq(course.location ?? null),
        num(course.ncrdb_facility_id),
        NOW_SQL,
        NOW_SQL,
      ].join(", ") +
      `) ON CONFLICT(id) DO UPDATE SET name=excluded.name, location=excluded.location, ` +
      `ncrdb_facility_id=excluded.ncrdb_facility_id, updated_at=excluded.updated_at;`,
    ...(course.sets ?? []).flatMap((set) => {
      const setRef = `(SELECT id FROM course_set WHERE course_id=${sq(course.id)} AND name=${sq(set.name)})`;
      return [
        `INSERT INTO course_set (id, course_id, name, usga_course_id, usga_course_nine, created_at, updated_at) VALUES (` +
          [
            sq(set.id),
            sq(course.id),
            sq(set.name),
            num(set.usga_course_id),
            sq(set.usga_course_nine ?? null),
            NOW_SQL,
            NOW_SQL,
          ].join(", ") +
          `) ON CONFLICT(course_id, name) DO UPDATE SET usga_course_id=excluded.usga_course_id, ` +
          `usga_course_nine=excluded.usga_course_nine, updated_at=excluded.updated_at;`,
        // Each tee row carries its ratings and its own hole layout (par can
        // differ by tee position).
        ...(set.tees ?? []).flatMap((tee) => {
          const gender = tee.gender ?? null;
          const teeRef =
            `(SELECT id FROM course_set_tee WHERE course_set_id=${setRef}` +
            ` AND lower(name)=lower(${sq(tee.name)})` +
            ` AND coalesce(gender, '')=coalesce(${sq(gender)}, ''))`;
          return [
            `INSERT INTO course_set_tee (id, course_set_id, name, gender, type, course_rating, slope_rating, created_at, updated_at) VALUES (` +
              [
                sq(tee.id),
                setRef,
                sq(tee.name),
                sq(gender),
                sq(tee.type ?? null),
                num(tee.course_rating),
                num(tee.slope_rating),
                NOW_SQL,
                NOW_SQL,
              ].join(", ") +
              `) ON CONFLICT(course_set_id, lower(name), coalesce(gender, '')) DO UPDATE SET ` +
              `type=excluded.type, course_rating=excluded.course_rating, slope_rating=excluded.slope_rating, updated_at=excluded.updated_at;`,
            ...(tee.holes ?? []).map(
              (hole) =>
                `INSERT INTO hole (id, course_set_tee_id, number, par, created_at, updated_at) VALUES (` +
                [sq(hole.id), teeRef, String(hole.number), String(hole.par), NOW_SQL, NOW_SQL].join(
                  ", ",
                ) +
                `) ON CONFLICT(course_set_tee_id, number) DO UPDATE SET par=excluded.par, updated_at=excluded.updated_at;`,
            ),
          ];
        }),
      ];
    }),
  ]);
}

const { values: flags } = parseArgs({
  options: {
    local: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
  },
});
if (!flags.local && !flags.remote) {
  console.error("Pass --local and/or --remote.");
  process.exit(1);
}

const root = path.dirname(import.meta.dir);
const sql =
  [...(await golferStatements(root)), ...(await courseStatements(root))].join("\n") + "\n";
const tmp = path.join(tmpdir(), `scorecard-seed-${crypto.randomUUID()}.sql`);
await Bun.write(tmp, sql);

// Invoke the wrangler binary directly (not `bunx wrangler`, which word-splits
// quoted arguments).
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
try {
  if (flags.local) {
    console.log("Seeding local D1…");
    const proc = Bun.spawn(
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
      {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await proc.exited) !== 0) process.exit(1);
  }
  if (flags.remote) {
    console.log("Seeding remote D1…");
    const proc = Bun.spawn(
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
      {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await proc.exited) !== 0) process.exit(1);
  }
} finally {
  await rm(tmp, { force: true });
}
