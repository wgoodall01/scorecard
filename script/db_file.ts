#!/usr/bin/env bun
// Print the path to the SQLite file backing the LOCAL wrangler (miniflare) D1
// database.
//
//   bun run db:file                 # print the absolute path
//   bun script/db_file.ts --link    # (re)point a stable ./local.db symlink at it
//
// wrangler dev stores the local D1 database under
// .wrangler/state/v3/d1/miniflare-D1DatabaseObject/ as a file whose name is a
// content hash — it changes whenever the D1 database_id changes — next to
// miniflare's own metadata.sqlite. This resolves the real database file
// dynamically (the most recently written *.sqlite that isn't metadata.sqlite).
//
// For a GUI like DataGrip that pins a data source to a fixed path, use --link:
// it creates ./local.db (gitignored) as a symlink to the current database file,
// so you point DataGrip at ./local.db once and it survives the hash renaming.
// (SQLite follows the symlink and keeps its -wal/-shm files next to the real
// file, so this works transparently.)

import { parseArgs } from "node:util";
import { existsSync, lstatSync, statSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { Glob } from "bun";

const root = path.dirname(import.meta.dir);

function dbPath(): string {
  const dir = path.join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(dir)) {
    console.error(
      `No local D1 state at ${dir}. Start it once with \`bun dev\` or \`bun db:migrate:local\`.`,
    );
    process.exit(1);
  }
  const files = [...new Glob("*.sqlite").scanSync({ cwd: dir, absolute: true })].filter(
    (p) => path.basename(p) !== "metadata.sqlite",
  );
  if (files.length === 0) {
    console.error(`No D1 database file found under ${dir}.`);
    process.exit(1);
  }
  // If a database_id change left an orphan behind, prefer the most recently
  // written file (the live one).
  files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  return files[files.length - 1];
}

const { values: flags } = parseArgs({
  options: { link: { type: "boolean", default: false } },
});

const db = dbPath();
if (flags.link) {
  const stable = path.join(root, "local.db");
  // lstat, not exists: a dangling symlink still needs removing.
  const present = (() => {
    try {
      lstatSync(stable);
      return true;
    } catch {
      return false;
    }
  })();
  if (present) await rm(stable, { force: true });
  await symlink(db, stable);
  console.log(stable);
} else {
  console.log(db);
}
