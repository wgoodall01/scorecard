import { hc } from "hono/client";
import { redirect, type ParsedLocation } from "@tanstack/react-router";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";
import type { AppType } from "api";

export { browserSupportsWebAuthn };

const TOKEN_KEY = "scorecard.auth.token";
const RETURN_TO_KEY = "scorecard.auth.return-to";

type AuthErrorBody = { error?: string };

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function safeReturnTo(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";

  const path = value.split(/[?#]/, 1)[0];
  return path === "/login" || path.startsWith("/login/") || path === "/register" ? "/" : value;
}

// Route-level auth guard: requires a signed-in user, and — with
// `{ admin: true }` — an admin one, resolved from /me in beforeLoad (admin
// status isn't in the token). Non-admins are bounced to the courses list.
// Within-page controls are still enforced by the API regardless.
export function checkAuth(options?: { admin?: boolean }) {
  return async ({ location }: { location: ParsedLocation }) => {
    const token = authService.getToken();
    if (!token) {
      throw redirect({
        to: "/login",
        search: { returnTo: safeReturnTo(location.href) },
        replace: true,
      });
    }
    if (options?.admin) {
      const response = await createApiClient(token)
        .api.me.$get()
        .catch(() => null);
      const body = response && response.ok ? await response.json() : null;
      if (!body?.user?.admin) throw redirect({ to: "/courses", replace: true });
    }
  };
}

async function requestError(response: { json: () => Promise<unknown> }) {
  const body = (await response.json().catch(() => ({}))) as AuthErrorBody;
  return body.error ?? "Something went wrong. Please try again.";
}

// A friendly message for a failed browser passkey ceremony (user dismissed the
// prompt, no matching passkey, unsupported, …).
function passkeyError(error: unknown, fallback: string) {
  if (error instanceof WebAuthnError) {
    if (error.name === "NotAllowedError")
      return new ApiError("No passkey was selected. Please try again.", 0);
    return new ApiError(error.message || fallback, 0);
  }
  return new ApiError(error instanceof Error ? error.message : fallback, 0);
}

// Best-effort device name from the browser, offered as the default passkey name
// (the user can edit it). Not security-relevant — just a friendly label.
export function suggestDeviceName() {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? "";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android device";
  if (platform === "macOS" || /Macintosh/.test(ua)) return "Mac";
  if (platform === "Windows" || /Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux device";
  return "This device";
}

export function createApiClient(token?: string) {
  return hc<AppType>(
    window.location.origin,
    token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  );
}

export type ApiClient = ReturnType<typeof createApiClient>;

// The API validates ceremony responses as a passthrough object (id + unknown
// rest); the SDK's typed response has no index signature, so widen it for the
// RPC json payload.
type CeremonyPayload = { id: string } & Record<string, unknown>;

class AuthService {
  getToken() {
    return window.localStorage.getItem(TOKEN_KEY);
  }

  setToken(token: string) {
    window.localStorage.setItem(TOKEN_KEY, token);
  }

  clearToken() {
    window.localStorage.removeItem(TOKEN_KEY);
  }

  getReturnTo() {
    return safeReturnTo(window.sessionStorage.getItem(RETURN_TO_KEY));
  }

  setReturnTo(returnTo: string) {
    window.sessionStorage.setItem(RETURN_TO_KEY, safeReturnTo(returnTo));
  }

  // Usernameless sign-in: the browser shows the user's saved passkeys.
  async signInWithPasskey() {
    const client = createApiClient();
    const optionsRes = await client.api.auth.passkey.options.$post();
    if (!optionsRes.ok) throw new ApiError(await requestError(optionsRes), optionsRes.status);
    const { challengeToken, options } = await optionsRes.json();

    let response;
    try {
      response = await startAuthentication({ optionsJSON: options });
    } catch (error) {
      throw passkeyError(error, "Unable to sign in with a passkey.");
    }

    const verifyRes = await client.api.auth.passkey.verify.$post({
      json: { challengeToken, response: response as unknown as CeremonyPayload },
    });
    if (!verifyRes.ok) throw new ApiError(await requestError(verifyRes), verifyRes.status);
    const { token } = await verifyRes.json();
    this.setToken(token);
    return token;
  }

  // Enroll a passkey — via an invite/recovery token (signed out) or on the
  // current device for the signed-in user (in-session, uses the stored token).
  async enrollPasskey({ inviteToken, name }: { inviteToken?: string; name?: string }) {
    const client = createApiClient(this.getToken() ?? undefined);
    const optionsRes = await client.api.auth.register.options.$post({ json: { inviteToken } });
    if (!optionsRes.ok) throw new ApiError(await requestError(optionsRes), optionsRes.status);
    const { challengeToken, options } = await optionsRes.json();

    let response;
    try {
      response = await startRegistration({ optionsJSON: options });
    } catch (error) {
      throw passkeyError(error, "Unable to set up a passkey.");
    }

    const verifyRes = await client.api.auth.register.verify.$post({
      json: { challengeToken, response: response as unknown as CeremonyPayload, name },
    });
    if (!verifyRes.ok) throw new ApiError(await requestError(verifyRes), verifyRes.status);
    const { token } = await verifyRes.json();
    this.setToken(token);
    return token;
  }

  // DEV ONLY. Trades an email for a session with no passkey ceremony, via the
  // local-only /auth/dev-login route (which 404s unless the Worker's
  // NODE_ENV === "development"). Callers must gate this behind
  // `process.env.NODE_ENV === "development"` so it's dead code in prod builds.
  async devLogin(email: string) {
    const response = await createApiClient().api.auth["dev-login"].$post({ json: { email } });
    if (!response.ok) throw new ApiError(await requestError(response), response.status);
    const { token } = await response.json();
    this.setToken(token);
    return token;
  }

  // Self-serve recovery / "email me a sign-in link". Always resolves (the API
  // never reveals whether the email exists).
  async requestRecovery(email: string) {
    const response = await createApiClient().api.auth.recover.$post({ json: { email } });
    if (!response.ok) throw new ApiError(await requestError(response), response.status);
  }
}

export const authService = new AuthService();
