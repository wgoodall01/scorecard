import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, authService } from "@/lib/auth";
import { api } from "@/lib/api";
import { apiQuery, queryClient } from "@/lib/query";

// email is null for golfers who exist only as players (no account yet) —
// though the signed-in user's own profile always has one (they logged in).
export type Profile = { id: string; email: string | null; name: string | null; admin: boolean };

type AuthContextValue = {
  token: string | null;
  profile: Profile | null;
  profileError: string | null;
  isAdmin: boolean;
  signInWithPasskey: () => Promise<void>;
  // DEV ONLY — see AuthService.devLogin. Gate calls on process.env.NODE_ENV.
  devLogin: (email: string) => Promise<void>;
  enrollPasskey: (opts: { inviteToken?: string; name?: string }) => Promise<void>;
  requestRecovery: (email: string) => Promise<void>;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => authService.getToken());

  // The signed-in user's profile. `api` reads the token per request, so the
  // token going from null to set is what enables this query.
  const profileQuery = useQuery({
    ...apiQuery(api.me.$get),
    enabled: token !== null,
    retry: false,
  });

  // A stored token whose subject no longer resolves: drop it so the app returns
  // to the signed-out state instead of loading forever. (A side effect on the
  // query's error — not a fetch.)
  const status = profileQuery.error instanceof ApiError ? profileQuery.error.status : null;
  useEffect(() => {
    if (status === 401 || status === 404) {
      authService.clearToken();
      setToken(null);
      queryClient.clear();
    }
  }, [status]);

  // A new session must not see the previous one's cached data.
  function adopt(newToken: string) {
    queryClient.clear();
    setToken(newToken);
  }

  const profile = profileQuery.data?.user ?? null;
  const profileError =
    profileQuery.error !== null && status !== 401 && status !== 404
      ? "Unable to load your profile."
      : null;

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      profile,
      profileError,
      isAdmin: profile?.admin ?? false,
      signInWithPasskey: async () => {
        adopt(await authService.signInWithPasskey());
      },
      devLogin: async (email) => {
        adopt(await authService.devLogin(email));
      },
      enrollPasskey: async (opts) => {
        adopt(await authService.enrollPasskey(opts));
      },
      requestRecovery: (email) => authService.requestRecovery(email),
      signOut: () => {
        authService.clearToken();
        setToken(null);
        queryClient.clear();
      },
    }),
    [profile, profileError, token],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}
