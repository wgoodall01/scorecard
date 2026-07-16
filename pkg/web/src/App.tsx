import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { CenterCardLayout } from "@/components/center-card-layout";
import { useAuth } from "@/lib/auth-context";
import { ApiError, authService, createApiClient } from "@/lib/auth";

export function HomePage() {
  const [pingResult, setPingResult] = useState<string | null>(null);
  const { token, signOut } = useAuth();

  async function handlePing() {
    const res = await createApiClient().api.ping.$post();
    const data = await res.json();
    setPingResult(data.time);
  }

  return (
    <Page>
      <h1 className="font-medium">Scorecard</h1>
      <p>Project ready!</p>
      <Button className="mt-2" onClick={handlePing}>
        POST /api/ping
      </Button>
      {pingResult && <p className="mt-2 font-mono text-xs text-muted-foreground">{pingResult}</p>}
      <div className="mt-4 flex gap-2">
        {token ? (
          <>
            <Link className={buttonVariants({ variant: "outline" })} to="/me">
              My profile
            </Link>
            <Button variant="outline" onClick={signOut}>
              Sign out
            </Button>
          </>
        ) : (
          <Link
            className={buttonVariants({ variant: "outline" })}
            to="/login"
            search={{ returnTo: "/" }}
          >
            Sign in
          </Link>
        )}
      </div>
    </Page>
  );
}

export function LoginPage({ returnTo }: { returnTo: string }) {
  const { requestCode, useCode } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notRegistered, setNotRegistered] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setStatus(null);
    setNotRegistered(false);
    try {
      authService.setReturnTo(returnTo);
      await requestCode(email);
      setStatus("Check your email for a six-digit code or magic link.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to send a code.");
      setNotRegistered(requestError instanceof ApiError && requestError.status === 404);
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await useCode(email, code);
      window.location.assign(authService.getReturnTo());
    } catch (useCodeError) {
      setError(useCodeError instanceof Error ? useCodeError.message : "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <CenterCardLayout>
      <div className="flex flex-col gap-1">
        <h1 className="font-medium">Sign in</h1>
        <p>We’ll email you a six-digit code.</p>
      </div>
      {status ? (
        <form className="flex flex-1 flex-col gap-6" onSubmit={verifyCode}>
          <p className="text-sm text-muted-foreground">{status}</p>
          <InputOTP
            containerClassName="w-full justify-center"
            maxLength={6}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            value={code}
            onChange={(value) => setCode(value)}
            required
          >
            <InputOTPGroup>
              {Array.from({ length: 3 }, (_, index) => (
                <InputOTPSlot index={index} key={index} />
              ))}
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              {Array.from({ length: 3 }, (_, index) => (
                <InputOTPSlot index={index + 3} key={index + 3} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <AuthActionBar>
            <Button className="w-full" type="submit" disabled={loading || code.length !== 6}>
              {loading ? "Signing in…" : "Sign in with code"}
            </Button>
          </AuthActionBar>
        </form>
      ) : (
        <form className="flex flex-1 flex-col gap-6" onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <input
              className="w-full rounded-md border bg-transparent px-3 py-2"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            {notRegistered && (
              <Link
                className={buttonVariants({ variant: "outline" })}
                to="/register"
                search={{ email, returnTo }}
              >
                Create an account
              </Link>
            )}
          </div>
          <AuthActionBar>
            <Button className="w-full" type="submit" disabled={loading}>
              {loading ? "Sending…" : "Email me a code"}
            </Button>
          </AuthActionBar>
        </form>
      )}
    </CenterCardLayout>
  );
}

export function RegisterPage({
  registeredEmail,
  returnTo,
}: {
  registeredEmail: string;
  returnTo: string;
}) {
  const { register, requestCode } = useAuth();
  const [email, setEmail] = useState(registeredEmail);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      authService.setReturnTo(returnTo);
      await register(email, name);
      await requestCode(email);
      setStatus("Your account is ready. Check your email for a magic link or sign-in code.");
    } catch (registerError) {
      setError(
        registerError instanceof Error ? registerError.message : "Unable to create your account.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <CenterCardLayout>
      <div className="flex flex-col gap-1">
        <h1 className="font-medium">Create your account</h1>
        <p>We’ll create your account and email you a sign-in link.</p>
      </div>
      <form className="flex flex-1 flex-col gap-6" onSubmit={submit}>
        <div className="flex flex-col gap-3">
          <input
            className="w-full rounded-md border bg-transparent px-3 py-2"
            type="text"
            autoComplete="name"
            placeholder="Your name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <input
            className="w-full rounded-md border bg-transparent px-3 py-2"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        {(status || error) && (
          <div className="flex flex-col gap-3">
            {status && <p className="text-sm text-muted-foreground">{status}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <AuthActionBar>
          <Button className="w-full" type="submit" disabled={loading}>
            {loading ? "Creating…" : "Create account"}
          </Button>
        </AuthActionBar>
      </form>
    </CenterCardLayout>
  );
}

export function MagicLinkPage({ email, code }: { email: string; code: string }) {
  const { useCode } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!email || !code) {
      setError("This magic link is incomplete.");
      return;
    }

    void useCode(email, code)
      .then(() => window.location.assign(authService.getReturnTo()))
      .catch((useCodeError) =>
        setError(useCodeError instanceof Error ? useCodeError.message : "Unable to sign in."),
      );
  }, [code, email, useCode]);

  return (
    <CenterCardLayout>
      <div className="flex flex-1 flex-col">
        <h1 className="font-medium">Signing you in…</h1>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </CenterCardLayout>
  );
}

export function MePage() {
  const { client, signOut } = useAuth();
  const [profile, setProfile] = useState<{ id: string; email: string; name: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    void client.api.me.$get().then(async (response) => {
      if (!response.ok) {
        setError("Unable to load your profile.");
        return;
      }
      const { user } = await response.json();
      setProfile(user);
    });
  }, [client]);

  return (
    <Page>
      <h1 className="font-medium">My profile</h1>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      {!profile && !error && <p className="mt-3 text-muted-foreground">Loading…</p>}
      {profile && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt>ID</dt>
          <dd>{profile.id}</dd>
          <dt>Email</dt>
          <dd>{profile.email}</dd>
          <dt>Name</dt>
          <dd>{profile.name ?? "—"}</dd>
        </dl>
      )}
      <div className="mt-4 flex gap-2">
        <Link className={buttonVariants({ variant: "outline" })} to="/">
          Home
        </Link>
        <Button variant="outline" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </Page>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token)
    return (
      <Navigate
        to="/login"
        search={{ returnTo: `${location.pathname}${location.searchStr}${location.hash}` }}
      />
    );
  return children;
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh p-6">
      <main className="flex max-w-md min-w-0 flex-col text-sm leading-loose">{children}</main>
    </div>
  );
}

function AuthActionBar({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto sm:mt-0">{children}</div>;
}
