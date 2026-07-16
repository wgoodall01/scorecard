import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "@tanstack/react-router";
import {
  Camera,
  LandPlot,
  LoaderCircle,
  LogOut,
  NotebookText,
  Settings,
  UserRound,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { CenterCardLayout } from "@/components/center-card-layout";
import { useAuth } from "@/lib/auth-context";
import { ApiError, authService } from "@/lib/auth";
import { resizeImageForCapture } from "@/lib/image_resize";

export function CapturePage() {
  const { token } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitCapture(image: File) {
    if (!token || isProcessing) return;

    setIsProcessing(true);
    setError(null);
    setResult(null);

    try {
      const form = new FormData();
      form.set("image", await resizeImageForCapture(image));
      const submitResponse = await fetch("/api/capture/submit", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const submitBody = (await submitResponse.json()) as { id?: string; error?: string };
      if (!submitResponse.ok || !submitBody.id)
        throw new Error(submitBody.error ?? "Unable to upload your scorecard.");

      for (let attempt = 0; attempt < 60; attempt++) {
        const resultResponse = await fetch(
          `/api/capture/result?id=${encodeURIComponent(submitBody.id)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (resultResponse.status === 202) {
          await new Promise((resolve) => window.setTimeout(resolve, 750));
          continue;
        }

        const resultBody = (await resultResponse.json()) as unknown;
        if (!resultResponse.ok) {
          const message =
            typeof resultBody === "object" && resultBody && "error" in resultBody
              ? String(resultBody.error)
              : "Unable to extract your scorecard.";
          throw new Error(message);
        }
        setResult(JSON.stringify(resultBody, null, 2));
        return;
      }

      throw new Error("Extraction is taking longer than expected. Please try again.");
    } catch (captureError) {
      setError(
        captureError instanceof Error ? captureError.message : "Unable to capture scorecard.",
      );
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <AppShell>
      <PageTitle>Capture · Scorecard</PageTitle>
      <PageHeading title="Capture" description="Upload a scorecard to start a new round." />
      <section className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Camera aria-hidden="true" />
        </div>
        <h2 className="mt-4 font-medium">Capture a scorecard</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Take a photo or choose an image from your library. We’ll extract the round details for
          you.
        </p>
        <label
          className={buttonVariants({
            className:
              "mt-5 cursor-pointer has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50",
          })}
        >
          {isProcessing ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Camera data-icon="inline-start" />
          )}
          {isProcessing ? "Extracting scorecard…" : "Choose scorecard image"}
          <input
            className="sr-only"
            type="file"
            accept="image/*"
            disabled={isProcessing}
            onChange={(event) => {
              const [image] = event.target.files ?? [];
              if (image) void submitCapture(image);
              event.target.value = "";
            }}
          />
        </label>
        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      </section>
      {result && (
        <section className="mt-6 rounded-xl border bg-card p-5">
          <h2 className="font-medium">Extracted JSON</h2>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-4 text-left text-xs leading-relaxed">
            {result}
          </pre>
        </section>
      )}
    </AppShell>
  );
}

export function OutingsPage() {
  return (
    <AppShell>
      <PageTitle>Outings · Scorecard</PageTitle>
      <PageHeading title="Outings" description="Your scorecard history will appear here." />
      <section className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <NotebookText aria-hidden="true" />
        </div>
        <h2 className="mt-4 font-medium">No outings yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Capture your first scorecard to begin building your history.
        </p>
        <Link className={buttonVariants({ className: "mt-5" })} to="/">
          <Camera data-icon="inline-start" />
          Capture a scorecard
        </Link>
      </section>
    </AppShell>
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
      <PageTitle>Sign in · Scorecard</PageTitle>
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
      <PageTitle>Create account · Scorecard</PageTitle>
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
      <PageTitle>Signing in · Scorecard</PageTitle>
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
    <AppShell>
      <PageTitle>Me · Scorecard</PageTitle>
      <PageHeading title="Me" description="Manage your profile and account." />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!profile && !error && <p className="text-sm text-muted-foreground">Loading your profile…</p>}
      {profile && (
        <div className="flex flex-col gap-5">
          <section className="rounded-xl border bg-card">
            <div className="flex items-center gap-3 border-b p-5">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <UserRound aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="font-medium">{profile.name ?? "Scorecard player"}</h2>
                <p className="truncate text-sm text-muted-foreground">{profile.email}</p>
              </div>
            </div>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 p-5 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{profile.name ?? "Not set"}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all">{profile.email}</dd>
            </dl>
          </section>
          <section className="rounded-xl border bg-card">
            <div className="border-b p-5">
              <h2 className="flex items-center gap-2 font-medium">
                <Settings aria-hidden="true" className="size-4" />
                Profile settings
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                More profile preferences are coming soon.
              </p>
            </div>
            <div className="p-5">
              <Button variant="outline" onClick={signOut}>
                <LogOut data-icon="inline-start" />
                Log out
              </Button>
            </div>
          </section>
        </div>
      )}
    </AppShell>
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

function AppShell({ children }: { children: React.ReactNode }) {
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
          <NavigationLink to="/me" icon={<UserRound aria-hidden="true" />} label="Me" />
        </nav>
      </aside>
      <main className="mx-auto w-full max-w-3xl px-5 py-8 pb-24 md:mx-0 md:px-10 md:py-10">
        {children}
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 flex border-t bg-background/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur md:hidden"
        aria-label="Main navigation"
      >
        <MobileNavigationLink to="/" icon={<Camera aria-hidden="true" />} label="Capture" />
        <MobileNavigationLink
          to="/outings"
          icon={<NotebookText aria-hidden="true" />}
          label="Outings"
        />
        <MobileNavigationLink to="/me" icon={<UserRound aria-hidden="true" />} label="Me" />
      </nav>
    </div>
  );
}

function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </header>
  );
}

function PageTitle({ children }: { children: string }) {
  return <title>{children}</title>;
}

function NavigationLink({
  to,
  icon,
  label,
}: {
  to: "/" | "/outings" | "/me";
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
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
  to: "/" | "/outings" | "/me";
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg py-1 text-xs font-medium text-muted-foreground transition-colors"
      activeProps={{ className: "text-primary" }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

function AuthActionBar({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto sm:mt-0">{children}</div>;
}
