#!/usr/bin/env nu
# Print the path to the SQLite file backing the LOCAL wrangler (miniflare) D1
# database.
#
#   bun run db:file            # print the absolute path
#   nu script/db_file.nu --link  # (re)point a stable ./local.db symlink at it
#
# wrangler dev stores the local D1 database under
# .wrangler/state/v3/d1/miniflare-D1DatabaseObject/ as a file whose name is a
# content hash — it changes whenever the D1 database_id changes — next to
# miniflare's own metadata.sqlite. This resolves the real database file
# dynamically (the most recently written *.sqlite that isn't metadata.sqlite).
#
# For a GUI like DataGrip that pins a data source to a fixed path, use --link:
# it creates ./local.db (gitignored) as a symlink to the current database file,
# so you point DataGrip at ./local.db once and it survives the hash renaming.
# (SQLite follows the symlink and keeps its -wal/-shm files next to the real
# file, so this works transparently.)

def db-path [] {
  let root = ($env.CURRENT_FILE | path dirname | path dirname)
  let dir = ($root | path join ".wrangler" "state" "v3" "d1" "miniflare-D1DatabaseObject")
  if not ($dir | path exists) {
    error make { msg: $"No local D1 state at ($dir). Start it once with `bun dev` or `bun db:migrate:local`." }
  }
  let files = (glob ($dir | path join "*.sqlite")
    | where {|p| ($p | path basename) != "metadata.sqlite"})
  if ($files | is-empty) {
    error make { msg: $"No D1 database file found under ($dir)." }
  }
  # If a database_id change left an orphan behind, prefer the most recently
  # written file (the live one).
  $files
  | each {|p| {name: $p, modified: (ls $p | first | get modified)} }
  | sort-by modified
  | last
  | get name
}

def main [--link] {
  let db = (db-path)
  if $link {
    let root = ($env.CURRENT_FILE | path dirname | path dirname)
    let stable = ($root | path join "local.db")
    if ($stable | path exists) or (($stable | path type) == "symlink") { rm --force $stable }
    ^ln -s $db $stable
    print $stable
  } else {
    print $db
  }
}
