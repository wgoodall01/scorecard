#!/usr/bin/env nu

# Generate a new production JWT signing key and upload it without logging it.
def main [] {
  let repo_root = ($env.FILE_PWD | path join ".." | path expand)
  cd $repo_root

  let secret = (^openssl rand -base64 48 | str trim)
  $secret | ^bunx wrangler secret put JWT_SECRET

  print "Rotated JWT_SECRET for the production Worker."
}
