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
# first. Course sets and holes upsert by their natural keys — (course_id,
# name) and (course_set_id, number) — so hand-created rows with the same
# natural key keep their ids.

# SQL-quote a value, mapping nushell null to NULL.
def sq [value] {
  if $value == null {
    "NULL"
  } else {
    "'" + ($value | into string | str replace --all "'" "''") + "'"
  }
}

def golfer-statements [root: string] {
  open ($root | path join "seed" "golfers.yaml") | get golfers | each {|golfer|
    let admin = if $golfer.admin { "1" } else { "0" }
    let user = ("INSERT INTO user (id, email, name, admin) VALUES ("
      + ([(sq $golfer.id), (sq ($golfer.email? | default null)), (sq $golfer.name), $admin] | str join ", ")
      + ") ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, "
      + "admin=excluded.admin;")
    let nicknames = $golfer.nicknames? | default [] | each {|nick|
      ("INSERT INTO nickname (id, user_id, nickname, nickname_type) VALUES ("
        + ([(sq $nick.id), (sq $golfer.id), (sq $nick.nickname), (sq $nick.type)] | str join ", ")
        + ") ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, "
        + "nickname=excluded.nickname, nickname_type=excluded.nickname_type;")
    }
    [$user] | append $nicknames
  } | flatten
}

def course-statements [root: string] {
  open ($root | path join "seed" "courses.yaml") | get courses | each {|course|
    let course_row = ("INSERT INTO course (id, name, location) VALUES ("
      + ([(sq $course.id), (sq $course.name), (sq ($course.location? | default null))] | str join ", ")
      + ") ON CONFLICT(id) DO UPDATE SET name=excluded.name, location=excluded.location;")
    let sets = $course.sets? | default [] | each {|set|
      let set_row = ("INSERT INTO course_set (id, course_id, name, disposition) VALUES ("
        + ([(sq $set.id), (sq $course.id), (sq $set.name), (sq ($set.disposition? | default null))] | str join ", ")
        + ") ON CONFLICT(course_id, name) DO UPDATE SET disposition=excluded.disposition;")
      let set_ref = ("(SELECT id FROM course_set WHERE course_id=" + (sq $course.id)
        + " AND name=" + (sq $set.name) + ")")
      let holes = $set.holes? | default [] | each {|hole|
        ("INSERT INTO hole (id, course_set_id, number, name, par) VALUES ("
          + ([(sq $hole.id), $set_ref, ($hole.number | into string), (sq ($hole.name? | default null)), ($hole.par | into string)] | str join ", ")
          + ") ON CONFLICT(course_set_id, number) DO UPDATE SET name=excluded.name, par=excluded.par;")
      }
      [$set_row] | append $holes
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
