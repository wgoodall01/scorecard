import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { CenterCardLayout } from "@/components/center-card-layout";
import { PageTitle } from "@/App";
import { useAuth } from "@/lib/auth-context";
import { ApiError, authService } from "@/lib/auth";

export function LoginPage({ returnTo, initialEmail }: { returnTo: string; initialEmail?: string }) {
  const { requestCode, useCode } = useAuth();
  const navigate = useNavigate();
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
      // returnTo is a runtime path (validated by the login route's search
      // schema), so navigate by href — the auth context updates reactively,
      // no full-page reload needed.
      await navigate({ href: returnTo, replace: true });
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
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!email || !code) {
      setError("This magic link is incomplete.");
      return;
    }

    // The magic link carries no returnTo; the sessionStorage note written
    // when the code was requested covers the same-tab case, and getReturnTo
    // re-validates it. A runtime path, so navigate by href.
    void useCode(email, code)
      .then(() => navigate({ href: authService.getReturnTo(), replace: true }))
      .catch((useCodeError) =>
        setError(useCodeError instanceof Error ? useCodeError.message : "Unable to sign in."),
      );
  }, [code, email, useCode, navigate]);

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
