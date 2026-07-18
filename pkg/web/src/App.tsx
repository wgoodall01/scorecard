import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Camera,
  Flag,
  LandPlot,
  LogOut,
  NotebookText,
  Share,
  UserRound,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CaptureFlow } from "@/components/capture-flow";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { CenterCardLayout } from "@/components/center-card-layout";
import { useAuth } from "@/lib/auth-context";
import { ApiError, authService } from "@/lib/auth";

export function CapturePage() {
  return (
    <AppShell>
      <PageTitle>Capture · Scorecard</PageTitle>
      <PageHeading title="Capture" description="Upload a scorecard to start a new round." />
      <CaptureFlow />
    </AppShell>
  );
}

export function LoginPage({ returnTo, initialEmail }: { returnTo: string; initialEmail?: string }) {
  const { requestCode, useCode } = useAuth();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isStandalone] = useState(
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      authService.setReturnTo(returnTo);
      await requestCode(email);
      setStatus("Check your email for a six-digit code or magic link.");
    } catch (requestError) {
      setError(
        requestError instanceof ApiError && requestError.status === 404
          ? "No account found for this email. Ask an admin to invite you."
          : requestError instanceof Error
            ? requestError.message
            : "Unable to send a code.",
      );
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
      <PageTitle>Sign in · Scorecard</PageTitle>
      <div className="flex flex-col gap-1">
        <h1 className="font-medium">Sign in</h1>
        <p>We’ll email you a six-digit code.</p>
      </div>
      {status ? (
        <form className="flex flex-col gap-6" onSubmit={verifyCode}>
          <p className="text-sm text-muted-foreground">{status}</p>
          {!isStandalone && (
            <aside className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm md:hidden">
              <p className="font-medium">Install Scorecard</p>
              <p className="mt-1 text-muted-foreground">
                In Safari, tap <Share aria-hidden="true" className="mx-0.5 inline size-4" /> Share,
                then choose <span className="font-medium text-foreground">Add to Home Screen</span>.
              </p>
            </aside>
          )}
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
          <Button className="w-full" type="submit" disabled={loading || code.length !== 6}>
            {loading ? "Signing in…" : "Sign in with code"}
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-6" onSubmit={submit}>
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
          </div>
          <Button className="w-full" type="submit" disabled={loading}>
            {loading ? "Sending…" : "Email me a code"}
          </Button>
        </form>
      )}
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
      <PageTitle>Signing in · Scorecard</PageTitle>
      <div className="flex flex-1 flex-col">
        <h1 className="font-medium">Signing you in…</h1>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </CenterCardLayout>
  );
}

export function MePage() {
  const { profile, profileError, signOut } = useAuth();
  const navigate = useNavigate();

  function handleSignOut() {
    signOut();
    void navigate({ to: "/login", search: { returnTo: "/" }, replace: true });
  }

  return (
    <AppShell>
      <PageTitle>Me · Scorecard</PageTitle>
      <PageHeading title="Me" description="Manage your profile and account." />
      <div className="flex flex-col gap-5">
        {profileError && <p className="text-sm text-destructive">{profileError}</p>}
        {!profile && !profileError && (
          <p className="text-sm text-muted-foreground">Loading your profile…</p>
        )}
        {profile && (
          <section className="rounded-xl border bg-card">
            <div className="flex items-center gap-3 border-b p-5">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <UserRound aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="font-medium">{profile.name ?? "Scorecard player"}</h2>
                <p className="truncate text-sm text-muted-foreground">
                  {profile.email ?? "No email"}
                </p>
              </div>
            </div>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 p-5 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{profile.name ?? "Not set"}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all">{profile.email ?? "Not set"}</dd>
            </dl>
          </section>
        )}
        <Button variant="outline" className="self-start" onClick={handleSignOut}>
          <LogOut data-icon="inline-start" />
          Log out
        </Button>
      </div>
    </AppShell>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-background md:flex">
      <aside className="hidden w-64 shrink-0 border-r bg-sidebar text-sidebar-foreground md:flex md:flex-col">
        <div className="flex h-16 items-center gap-2 px-5 font-medium">
          <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <LandPlot aria-hidden="true" />
          </span>
          Scorecard
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-3" aria-label="Main navigation">
          <NavigationLink to="/" icon={<Camera aria-hidden="true" />} label="Capture" />
          <NavigationLink
            to="/outings"
            icon={<NotebookText aria-hidden="true" />}
            label="Outings"
          />
          <NavigationLink to="/courses" icon={<Flag aria-hidden="true" />} label="Courses" />
          <NavigationLink to="/golfers" icon={<Users aria-hidden="true" />} label="Golfers" />
          <NavigationLink to="/me" icon={<UserRound aria-hidden="true" />} label="Me" />
        </nav>
      </aside>
      <main className="mx-auto w-full max-w-3xl px-5 pt-[calc(2rem+env(safe-area-inset-top))] pb-[calc(6rem+env(safe-area-inset-bottom))] md:mx-0 md:px-10 md:py-10">
        {children}
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 flex border-t bg-background/95 pt-2 pb-[max(0.75rem,calc(env(safe-area-inset-bottom)+0.5rem))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] backdrop-blur md:hidden"
        aria-label="Main navigation"
      >
        <MobileNavigationLink to="/" icon={<Camera aria-hidden="true" />} label="Capture" />
        <MobileNavigationLink
          to="/outings"
          icon={<NotebookText aria-hidden="true" />}
          label="Outings"
        />
        <MobileNavigationLink to="/courses" icon={<Flag aria-hidden="true" />} label="Courses" />
        <MobileNavigationLink to="/golfers" icon={<Users aria-hidden="true" />} label="Golfers" />
        <MobileNavigationLink to="/me" icon={<UserRound aria-hidden="true" />} label="Me" />
      </nav>
    </div>
  );
}

export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-8 flex items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {actions}
    </header>
  );
}

export function PageTitle({ children }: { children: string }) {
  return <title>{children}</title>;
}

type NavigationTarget = "/" | "/outings" | "/courses" | "/golfers" | "/me";

function NavigationLink({
  to,
  icon,
  label,
}: {
  to: NavigationTarget;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      // Prefix matching keeps a tab lit on its subpaths (/outings/<id> etc.);
      // "/" must stay exact or Capture would match every route.
      activeOptions={{ exact: to === "/" }}
      className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}
    >
      {icon}
      {label}
    </Link>
  );
}

function MobileNavigationLink({
  to,
  icon,
  label,
}: {
  to: NavigationTarget;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      // Prefix matching keeps a tab lit on its subpaths (/outings/<id> etc.);
      // "/" must stay exact or Capture would match every route.
      activeOptions={{ exact: to === "/" }}
      className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-xs font-medium text-muted-foreground transition-colors"
      activeProps={{ className: "text-primary" }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
