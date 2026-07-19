import type { Env } from "../../env";

// Sign-in and invite magic codes. Each code is stored in the AUTH_CODES KV
// under a key that INCLUDES the code itself, so more than one code can be
// active for a single email at once — an invite's 24-hour link and a freshly
// requested sign-in code coexist, each expiring on its own TTL, instead of a
// new code clobbering the previous one (the old one-key-per-email scheme).

export const SIGN_IN_CODE_TTL_SECONDS = 10 * 60; // short-lived sign-in code
export const INVITE_CODE_TTL_SECONDS = 24 * 60 * 60; // 24h invite link

export function createCode() {
  const values = crypto.getRandomValues(new Uint32Array(6));
  return [...values].map((value) => String(value % 10)).join("");
}

function base64UrlEncode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function emailHash(email: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return base64UrlEncode(new Uint8Array(digest));
}

// KV key for one (email, code) pair. Listing by the `auth:code:<hash>:` prefix
// enumerates every active code for an email (used by the local-testing flow in
// CLAUDE.md).
export async function codeEntryKey(email: string, code: string) {
  return `auth:code:${await emailHash(email)}:${code}`;
}

// Mint a code for `email`, store it with the given TTL, and return it. Multiple
// calls yield multiple independently-valid codes.
export async function issueCode(
  env: Env["Bindings"],
  email: string,
  ttlSeconds: number = SIGN_IN_CODE_TTL_SECONDS,
): Promise<string> {
  const code = createCode();
  await env.AUTH_CODES.put(await codeEntryKey(email, code), "1", { expirationTtl: ttlSeconds });
  return code;
}

// Redeem a code: true (and delete it, so it's single-use) if it's currently
// valid for `email`, false otherwise.
export async function redeemCode(
  env: Env["Bindings"],
  email: string,
  code: string,
): Promise<boolean> {
  const key = await codeEntryKey(email, code);
  if (!(await env.AUTH_CODES.get(key))) return false;
  await env.AUTH_CODES.delete(key);
  return true;
}

// The `/login/magic` URL that redeems (email, code) on load.
export function magicLink(origin: string | URL, email: string, code: string): URL {
  const url = new URL("/login/magic", origin);
  url.searchParams.set("email", email);
  url.searchParams.set("code", code);
  return url;
}
