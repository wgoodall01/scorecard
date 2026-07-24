import { hc } from "hono/client";
import { hcQuery } from "hono-rpc-query";
import type { AppType } from "api";
import { authService } from "@/lib/auth";

// One API client for the whole app. The bearer token is read per request rather
// than baked in, so the client — and the TanStack Query keys derived from it —
// stay stable across sign-in and sign-out (the cache is cleared on sign-out
// instead; see `lib/query.ts`). The passkey ceremonies in `lib/auth.ts` keep
// their own short-lived clients: they run before there's a session to speak of.
const client = hc<AppType>(window.location.origin, {
  headers: (): Record<string, string> => {
    const token = authService.getToken();
    return token === null ? {} : { Authorization: `Bearer ${token}` };
  },
});

// The query-aware mirror of the client (hono-rpc-query). Every endpoint gains
// `.queryOptions()` / `.mutationOptions()` / `.call()`; we go through the
// `apiQuery`/`apiMutation` wrappers in `lib/query.ts` so a failed response
// becomes an error instead of data.
export const api = hcQuery(client).api;
