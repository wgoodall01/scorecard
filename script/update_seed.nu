#!/usr/bin/env nu
# Upsert the YAML seed data in seed/ into the scorecard D1 database(s).
#
#   nu script/update_seed.nu --local
#   nu script/update_seed.nu --local --remote
#
# Users, nicknames, and courses upsert by ID — the uuidv7s baked into the
# YAML files are canonical (foreign keys point at them), and user emails may
# be null. A pre-existing user row whose email collides with a seeded one
# under a different id fails loudly on the unique email index; align the ids
# first. Course sets, tees, and holes upsert by their natural keys —
# (course_id, name), (course_set_id, lower(name), coalesce(gender, '')), and
# (course_set_tee_id, number) — so hand-created rows with the same natural
# key keep their ids; every row's id is hardcoded in the YAML and is only
# used on first insert.

# SQL-quote a value, mapping nushell null to NULL.
def sq [value] {
  if $value == null {
    "NULL"
  } else {
    "'" + ($value | into string | str replace --all "'" "''") + "'"
  }
}

# ISO-8601 "now" for the created_at/updated_at audit columns — raw-SQL
# inserts bypass drizzle's app-level defaults, so the seed sets them itself
# (created_at sticks from first insert; updated_at refreshes on every upsert).
const now_sql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

def golfer-statements [root: string] {
  open ($root | path join "seed" "golfers.yaml") | get golfers | each {|golfer|
    let admin = if $golfer.admin { "1" } else { "0" }
    let user = ("INSERT INTO user (id, email, name, admin, created_at, updated_at) VALUES ("
      + ([(sq $golfer.id), (sq ($golfer.email? | default null)), (sq $golfer.name), $admin, $now_sql, $now_sql] | str join ", ")
      + ") ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, "
      + "admin=excluded.admin, updated_at=excluded.updated_at;")
    let nicknames = $golfer.nicknames? | default [] | each {|nick|
      ("INSERT INTO nickname (id, user_id, nickname, nickname_type, created_at, updated_at) VALUES ("
        + ([(sq $nick.id), (sq $golfer.id), (sq $nick.nickname), (sq $nick.type), $now_sql, $now_sql] | str join ", ")
        + ") ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, "
        + "nickname=excluded.nickname, nickname_type=excluded.nickname_type, updated_at=excluded.updated_at;")
    }
    [$user] | append $nicknames
  } | flatten
}

def course-statements [root: string] {
  open ($root | path join "seed" "courses.yaml") | get courses | each {|course|
    let facility_id = $course.ncrdb_facility_id? | default null | if $in == null { "NULL" } else { $in | into string }
    let course_row = ("INSERT INTO course (id, name, location, ncrdb_facility_id, created_at, updated_at) VALUES ("
      + ([(sq $course.id), (sq $course.name), (sq ($course.location? | default null)), $facility_id, $now_sql, $now_sql] | str join ", ")
      + ") ON CONFLICT(id) DO UPDATE SET name=excluded.name, location=excluded.location, "
      + "ncrdb_facility_id=excluded.ncrdb_facility_id, updated_at=excluded.updated_at;")
    let sets = $course.sets? | default [] | each {|set|
      let usga_course_id = $set.usga_course_id? | default null | if $in == null { "NULL" } else { $in | into string }
      let set_row = ("INSERT INTO course_set (id, course_id, name, usga_course_id, usga_course_nine, created_at, updated_at) VALUES ("
        + ([(sq $set.id), (sq $course.id), (sq $set.name), $usga_course_id, (sq ($set.usga_course_nine? | default null)), $now_sql, $now_sql] | str join ", ")
        + ") ON CONFLICT(course_id, name) DO UPDATE SET usga_course_id=excluded.usga_course_id, "
        + "usga_course_nine=excluded.usga_course_nine, updated_at=excluded.updated_at;")
      let set_ref = ("(SELECT id FROM course_set WHERE course_id=" + (sq $course.id)
        + " AND name=" + (sq $set.name) + ")")
      # Each tee row carries its ratings and its own hole layout (par can
      # differ by tee position).
      let tees = $set.tees? | default [] | each {|tee|
        let gender = $tee.gender? | default null
        let rating_sql = $tee.course_rating? | default null | if $in == null { "NULL" } else { $in | into string }
        let slope_sql = $tee.slope_rating? | default null | if $in == null { "NULL" } else { $in | into string }
        let tee_row = ("INSERT INTO course_set_tee (id, course_set_id, name, gender, type, course_rating, slope_rating, created_at, updated_at) VALUES ("
          + ([(sq $tee.id), $set_ref, (sq $tee.name), (sq $gender), (sq ($tee.type? | default null)), $rating_sql, $slope_sql, $now_sql, $now_sql] | str join ", ")
          + ") ON CONFLICT(course_set_id, lower(name), coalesce(gender, '')) DO UPDATE SET "
          + "type=excluded.type, course_rating=excluded.course_rating, slope_rating=excluded.slope_rating, updated_at=excluded.updated_at;")
        let tee_ref = ("(SELECT id FROM course_set_tee WHERE course_set_id=" + $set_ref
          + " AND lower(name)=lower(" + (sq $tee.name) + ")"
          + " AND coalesce(gender, '')=coalesce(" + (sq $gender) + ", ''))")
        let holes = $tee.holes? | default [] | each {|hole|
          ("INSERT INTO hole (id, course_set_tee_id, number, par, created_at, updated_at) VALUES ("
            + ([(sq $hole.id), $tee_ref, ($hole.number | into string), ($hole.par | into string), $now_sql, $now_sql] | str join ", ")
            + ") ON CONFLICT(course_set_tee_id, number) DO UPDATE SET par=excluded.par, updated_at=excluded.updated_at;")
        }
        [$tee_row] | append $holes
      } | flatten
      [$set_row] | append $tees
    } | flatten
    [$course_row] | append $sets
  } | flatten
}

def main [
  --local   # Apply the seed to the local D1 database (wrangler dev state)
  --remote  # Apply the seed to the remote (production) D1 database
] {
  if not ($local or $remote) {
    error make { msg: "Pass --local and/or --remote." }
  }

  let root = $env.CURRENT_FILE | path dirname | path dirname
  let sql = (golfer-statements $root) | append (course-statements $root) | str join "\n"
  let tmp = mktemp --tmpdir scorecard-seed-XXXXXX.sql
  $sql + "\n" | save --force $tmp

  cd $root
  if $local {
    print "Seeding local D1…"
    ^bunx wrangler d1 execute scorecard --local --config wrangler.toml --file $tmp
  }
  if $remote {
    print "Seeding remote D1…"
    ^bunx wrangler d1 execute scorecard --remote --yes --config wrangler.toml --file $tmp
  }
  rm $tmp
}
