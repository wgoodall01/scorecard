import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { authService, createApiClient, type ApiClient } from "@/lib/auth";

// email is null for golfers who exist only as players (no account yet) —
// though the signed-in user's own profile always has one (they logged in).
export type Profile = { id: string; email: string | null; name: string | null; admin: boolean };

type AuthContextValue = {
  token: string | null;
  client: ApiClient | null;
  profile: Profile | null;
  profileError: string | null;
  isAdmin: boolean;
  requestCode: (email: string) => Promise<void>;
  useCode: (email: string, code: string) => Promise<void>;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => authService.getToken());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const client = useMemo(() => (token ? createApiClient(token) : null), [token]);

  useEffect(() => {
    if (!client) {
      setProfile(null);
      setProfileError(null);
      return;
    }

    let cancelled = false;
    setProfileError(null);
    void client.api.me.$get().then(
      async (response) => {
        if (cancelled) return;
        if (response.status === 401 || response.status === 404) {
          // The stored token no longer maps to a user — drop it so the app
          // returns to the signed-out state instead of loading forever.
          authService.clearToken();
          setToken(null);
          return;
        }
        if (!response.ok) {
          setProfileError("Unable to load your profile.");
          return;
        }
        const { user } = await response.json();
        if (!cancelled) setProfile(user);
      },
      () => {
        if (!cancelled) setProfileError("Unable to load your profile.");
      },
    );

    return () => {
      cancelled = true;
    };
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      client,
      profile,
      profileError,
      isAdmin: profile?.admin ?? false,
      requestCode: (email) => authService.requestCode(email),
      useCode: async (email, code) => {
        setToken(await authService.useCode(email, code));
      },
      signOut: () => {
        authService.clearToken();
        setToken(null);
      },
    }),
    [client, profile, profileError, token],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}
