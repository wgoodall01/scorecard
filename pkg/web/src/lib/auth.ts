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

// Route-level auth guard: requires a signed-in user. Always gate routes here;
// finer-grained permissions (e.g. admin-only controls) are checked in
// components against the profile and enforced by the API.
export function checkAuth() {
  return ({ location }: { location: ParsedLocation }) => {
    const token = authService.getToken();
    if (!token) {
      throw redirect({
        to: "/login",
        search: { returnTo: safeReturnTo(location.href) },
        replace: true,
      });
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
