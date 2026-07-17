#!/usr/bin/env nu

# Promote a user to admin by email. This is the bootstrap for the first
# admin: /admin/invite itself requires an existing admin, so the first one
# has to be set directly in D1.
def main [
  email: string # Email of the user to promote
  --local # Target the local wrangler dev database
  --remote # Target the production D1 database
] {
  if $local == $remote {
    error make {msg: "Pass exactly one of --local or --remote."}
  }
  let target = if $local { "--local" } else { "--remote" }

  let repo_root = ($env.FILE_PWD | path join ".." | path expand)
  cd $repo_root

  # Match the API's email normalization (trim + lowercase), and escape
  # single quotes since wrangler d1 execute has no parameter binding.
  let normalized = ($email | str trim | str downcase)
  let escaped = ($normalized | str replace --all "'" "''")
  let sql = $"UPDATE user SET admin = 1 WHERE email = '($escaped)' RETURNING email;"

  # Invoke wrangler's binary directly: bunx (1.3.9) re-splits arguments on
  # spaces when respawning, which mangles the quoted --command SQL.
  let output = (
    ^./node_modules/.bin/wrangler d1 execute scorecard $target --json --command $sql | from json
  )
  let updated = ($output | first | get results)

  if ($updated | is-empty) {
    error make {msg: $"No user found with email ($normalized) — invite or create them first."}
  }
  print $"($normalized) is now an admin."
}
