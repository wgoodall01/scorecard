/// <reference types="vite/client" />

// The Worker (nodejs_compat) exposes `process.env` at runtime, and Vite
// statically replaces `process.env.NODE_ENV` in the client bundle. The web
// tsconfig (vite/client + workers-types) declares neither `process` — yet it
// also type-checks the API sources it imports, some of which read
// `process.env` (e.g. the dev-login gate). Declare the minimal shape here so
// both sides compile; it's types-only and erased at build.
declare const process: { env: Record<string, string | undefined> };
