#!/usr/bin/env nu
# Upsert the scraped USGA NCRDB JSONL into the app's read-only usga_* tables.
#
#   nu scripts/sync.nu --local
#   nu scripts/sync.nu --local --remote
#   nu scripts/sync.nu --remote --dir /path/to/output
#
# Reads course.jsonl and tee.jsonl (produced by `bun ncrdb.ts scrape`) and
# upserts them into the scorecard D1 database's usga_facility / usga_course /
# usga_tee tables. Those three tables are WHOLLY OWNED by this scraper — the app
# only ever reads them — so this is the sole writer.
#
# Rows upsert by their natural USGA id (facility_id / course_id / tee_id via
# ON CONFLICT DO UPDATE), so re-running is idempotent and refreshes changed
# rows. Field placement mirrors the schema: facility-level fields that are
# constant across all of a facility's courses live on usga_facility; anything
# that varies per course (street address, city, legacy id) lives on usga_course.
#
# Loading is batched: rows are packed into multi-row INSERT statements
# (--batch rows each) and those statements are grouped into files
# (--per-file statements each) run through one `wrangler d1 execute --file`
# call apiece, keeping every request comfortably bounded (there are ~12k
# facilities, ~14k courses, ~125k tees).

# SQL-quote ANY value as a string literal, mapping nushell null to NULL. Single
# quotes are doubled ('' ) — the only escaping SQLite string literals need
# (unlike MySQL, SQLite gives backslash no special meaning), so this makes an
# arbitrary value safe to interpolate. Every text column goes through this.
def sq [value] {
  if $value == null {
    "NULL"
  } else {
    "'" + ($value | into string | str replace --all "'" "''") + "'"
  }
}

# Render a value destined for a NUMERIC column as a bare SQL literal. A bare
# (unquoted) literal is only safe if it is genuinely a number, so this REFUSES
# anything that isn't int/float (null → NULL). That guarantees nothing but a
# validated number is ever emitted unquoted; a malformed source value aborts the
# whole run (this all happens while building statements, before any DB write)
# instead of silently corrupting data or breaking out of the statement.
def numlit [value] {
  if $value == null {
    "NULL"
  } else {
    let t = ($value | describe)
    if $t not-in ["int" "float"] {
      error make { msg: $"expected a number for a numeric column, got ($t): ($value | to nuon)" }
    }
    $value | into string
  }
}

# ISO-8601 "now" for the created_at/updated_at audit columns — raw-SQL inserts
# bypass drizzle's app-level defaults, so the sync sets them itself (created_at
# sticks from first insert; updated_at refreshes on every upsert).
const now_sql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

# Ensure a .jsonl exists, decompressing its committed .jsonl.zst snapshot if the
# raw file is absent (the .zst is kept). Needs the `zstd` CLI on PATH.
def ensure-jsonl [path: string] {
  if ($path | path exists) { return }
  let zst = $"($path).zst"
  if ($zst | path exists) {
    print $"Decompressing (($zst | path basename))…"
    ^zstd -d -k -f -o $path $zst
  }
}

# Read a JSONL file into a table of records (one object per non-blank line).
def read-jsonl [path: string] {
  open --raw $path
  | lines
  | where {|l| ($l | str trim | str length) > 0}
  | each {|l| $l | from json}
}

# Pack already-rendered "(v1, v2, …)" value-tuple strings into multi-row
# "INSERT INTO … VALUES … ON CONFLICT …" statements, `batch` rows each.
def build-inserts [
  tuples: list<string>
  prefix: string # "INSERT INTO t (a, b, …) VALUES "
  suffix: string # "ON CONFLICT(pk) DO UPDATE SET …"
  batch: int
] {
  $tuples | chunks $batch | each {|group|
    $prefix + ($group | str join ", ") + " " + $suffix + ";"
  }
}

# Group statements into files and run each file through wrangler d1 execute for
# every requested target. `cwd` must be the repo root (where wrangler.toml and
# node_modules/.bin/wrangler live).
def apply-statements [
  statements: list<string>
  --local
  --remote
  --per-file: int
] {
  let batches = ($statements | chunks $per_file)
  let total = ($batches | length)
  $batches | enumerate | each {|it|
    let tmp = (mktemp --tmpdir usga-sync-XXXXXX.sql)
    (($it.item | str join "\n") + "\n") | save --force $tmp
    if $local {
      print $"    file ($it.index + 1)/($total) → local"
      ^./node_modules/.bin/wrangler d1 execute scorecard --local --config wrangler.toml --file $tmp
    }
    if $remote {
      print $"    file ($it.index + 1)/($total) → remote"
      ^./node_modules/.bin/wrangler d1 execute scorecard --remote --yes --config wrangler.toml --file $tmp
    }
    rm $tmp
  }
  null
}

def main [
  --local # Apply to the local D1 database (wrangler dev state)
  --remote # Apply to the remote (production) D1 database
  --dir: string # Directory holding course.jsonl / tee.jsonl (default: ../output)
  --batch: int = 50 # Rows per multi-row INSERT statement
  --per-file: int = 500 # INSERT statements per wrangler execute call
] {
  if not ($local or $remote) {
    error make { msg: "Pass --local and/or --remote." }
  }

  let pkg = ($env.CURRENT_FILE | path dirname | path dirname)
  let root = ($pkg | path dirname | path dirname)
  let out = ($dir | default ($pkg | path join "output"))
  let course_path = ($out | path join "course.jsonl")
  let tee_path = ($out | path join "tee.jsonl")

  # Fall back to the committed .jsonl.zst snapshots when the raw JSONL is absent.
  ensure-jsonl $course_path
  ensure-jsonl $tee_path

  for p in [$course_path $tee_path] {
    if not ($p | path exists) {
      error make { msg: $"Missing ($p) (and no ($p).zst). Run `bun ncrdb.ts scrape` first, or pass --dir." }
    }
  }

  # usga_* tables carry no foreign keys between them, so load order is free.
  let courses = (read-jsonl $course_path)

  print $"Facilities: deduping ($courses | length) course rows by facility…"
  let facilities = ($courses | uniq-by facilityID)
  let facility_tuples = ($facilities | each {|c|
    "(" + ([
      (numlit $c.facilityID)
      (sq $c.facilityName)
      (sq $c.state)
      (sq $c.country)
      (numlit $c.entCountryCode)
      (numlit $c.entStateCode)
      (sq $c.telephone)
      (sq $c.email)
      (sq $c.stateDisplay)
      $now_sql
      $now_sql
    ] | str join ", ") + ")"
  })
  let facility_sql = (build-inserts $facility_tuples
    "INSERT INTO usga_facility (facility_id, name, state, country, ent_country_code, ent_state_code, telephone, email, state_display, created_at, updated_at) VALUES "
    ("ON CONFLICT(facility_id) DO UPDATE SET name=excluded.name, state=excluded.state, "
      + "country=excluded.country, ent_country_code=excluded.ent_country_code, "
      + "ent_state_code=excluded.ent_state_code, telephone=excluded.telephone, "
      + "email=excluded.email, state_display=excluded.state_display, updated_at=excluded.updated_at")
    $batch)

  print $"Courses: ($courses | length) rows…"
  let course_tuples = ($courses | each {|c|
    "(" + ([
      (numlit $c.courseID)
      (numlit $c.facilityID)
      (sq $c.courseName)
      (sq $c.fullName)
      (sq $c.address1)
      (sq $c.address2)
      (sq $c.city)
      (numlit $c.legacyCRPCourseId)
      $now_sql
      $now_sql
    ] | str join ", ") + ")"
  })
  let course_sql = (build-inserts $course_tuples
    "INSERT INTO usga_course (course_id, facility_id, name, full_name, address1, address2, city, legacy_crp_course_id, created_at, updated_at) VALUES "
    ("ON CONFLICT(course_id) DO UPDATE SET facility_id=excluded.facility_id, name=excluded.name, "
      + "full_name=excluded.full_name, address1=excluded.address1, address2=excluded.address2, "
      + "city=excluded.city, legacy_crp_course_id=excluded.legacy_crp_course_id, updated_at=excluded.updated_at")
    $batch)

  print "Tees: reading tee.jsonl…"
  let tees = (read-jsonl $tee_path)
  print $"Tees: ($tees | length) rows…"
  let tee_tuples = ($tees | each {|t|
    "(" + ([
      (numlit $t.teeId)
      (numlit $t.courseID)
      (sq $t.teeName)
      (sq $t.gender)
      (numlit $t.par)
      (numlit $t.courseRating)
      (numlit $t.bogeyRating)
      (numlit $t.slopeRating)
      (numlit $t.length)
      (numlit $t.front9.courseRating)
      (numlit $t.front9.slopeRating)
      (numlit $t.back9.courseRating)
      (numlit $t.back9.slopeRating)
      $now_sql
      $now_sql
    ] | str join ", ") + ")"
  })
  let tee_sql = (build-inserts $tee_tuples
    "INSERT INTO usga_tee (tee_id, course_id, name, gender, par, course_rating, bogey_rating, slope_rating, length, front9_course_rating, front9_slope_rating, back9_course_rating, back9_slope_rating, created_at, updated_at) VALUES "
    ("ON CONFLICT(tee_id) DO UPDATE SET course_id=excluded.course_id, name=excluded.name, "
      + "gender=excluded.gender, par=excluded.par, course_rating=excluded.course_rating, "
      + "bogey_rating=excluded.bogey_rating, slope_rating=excluded.slope_rating, length=excluded.length, "
      + "front9_course_rating=excluded.front9_course_rating, front9_slope_rating=excluded.front9_slope_rating, "
      + "back9_course_rating=excluded.back9_course_rating, back9_slope_rating=excluded.back9_slope_rating, "
      + "updated_at=excluded.updated_at")
    $batch)

  cd $root
  print $"\nusga_facility: ($facility_sql | length) batches"
  apply-statements $facility_sql --local=$local --remote=$remote --per-file $per_file
  print $"usga_course: ($course_sql | length) batches"
  apply-statements $course_sql --local=$local --remote=$remote --per-file $per_file
  print $"usga_tee: ($tee_sql | length) batches"
  apply-statements $tee_sql --local=$local --remote=$remote --per-file $per_file
  print "Done."
}
