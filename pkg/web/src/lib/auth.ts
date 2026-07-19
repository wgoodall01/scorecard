import { hc } from "hono/client";
import { redirect, type ParsedLocation } from "@tanstack/react-router";
import type { AppType } from "api";

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

export function createApiClient(token?: string) {
  return hc<AppType>(
    window.location.origin,
    token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  );
}

export type ApiClient = ReturnType<typeof createApiClient>;

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

  async requestCode(email: string) {
    const response = await createApiClient().api.auth.code.$post({ json: { email } });
    if (!response.ok) throw new ApiError(await requestError(response), response.status);
  }

  async useCode(email: string, code: string) {
    const response = await createApiClient().api.auth.token.$post({ json: { email, code } });
    if (!response.ok) throw new ApiError(await requestError(response), response.status);

    const { token } = await response.json();
    this.setToken(token);
    return token;
  }
}

export const authService = new AuthService();
