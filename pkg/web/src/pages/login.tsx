import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, MailCheck, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CenterCardLayout } from "@/components/center-card-layout";
import { PageTitle } from "@/App";
import { useAuth } from "@/lib/auth-context";
import { ApiError, authService, browserSupportsWebAuthn } from "@/lib/auth";

export function LoginPage({ returnTo, initialEmail }: { returnTo: string; initialEmail?: string }) {
  const { signInWithPasskey, requestRecovery } = useAuth();
  const navigate = useNavigate();
  const [supported] = useState(() => browserSupportsWebAuthn());
  const [email, setEmail] = useState(initialEmail ?? "");
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoverySent, setRecoverySent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isStandalone] = useState(
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );

  async function signIn() {
    setLoading(true);
    setError(null);
    try {
      await signInWithPasskey();
      // returnTo is a runtime path (validated by the login route's search
      // schema); the auth context updates reactively, no reload needed.
      await navigate({ href: returnTo, replace: true });
    } catch (signInError) {
      // Any passkey failure — no passkey on this device, a dismissed prompt, or
      // a network "Load failed" — should point the user at the email fallback
      // rather than dead-end. ApiError carries a friendly message; anything
      // else gets a generic one.
      setError(
        signInError instanceof ApiError
          ? signInError.message
          : "Couldn’t sign in with a passkey on this device.",
      );
      setShowRecovery(true);
    } finally {
      setLoading(false);
    }
  }

  async function sendRecovery() {
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      // The enroll link's landing reads this to return the user where they meant
      // to go after setting up a passkey.
      authService.setReturnTo(returnTo);
      await requestRecovery(email);
      setRecoverySent(true);
    } catch (recoveryError) {
      setError(
        recoveryError instanceof Error ? recoveryError.message : "Unable to send a sign-in link.",
      );
    } finally {
      setLoading(false);
    }
  }

  const installHint = !isStandalone && (
    <aside className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm md:hidden">
      <p className="font-medium">Install Scorecard</p>
      <p className="mt-1 text-muted-foreground">
        In Safari, tap <Share aria-hidden="true" className="mx-0.5 inline size-4" /> Share, then
        choose <span className="font-medium text-foreground">Add to Home Screen</span>.
      </p>
    </aside>
  );

  if (recoverySent) {
    return (
      <CenterCardLayout>
        <PageTitle>Check your email · Scorecard</PageTitle>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MailCheck aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="font-medium">Check your email</h1>
            <p className="text-sm text-muted-foreground">
              If an account exists for <span className="font-medium text-foreground">{email}</span>,
              we’ve sent a link to set up a passkey on this device. It expires in an hour.
            </p>
          </div>
        </div>
        {installHint}
        <Button
          variant="outline"
          className="self-center"
          onClick={() => {
            setRecoverySent(false);
            setError(null);
          }}
        >
          Use a different email
        </Button>
      </CenterCardLayout>
    );
  }

  return (
    <CenterCardLayout>
      <PageTitle>Sign in · Scorecard</PageTitle>
      <div className="flex flex-col gap-1">
        <h1 className="font-medium">Sign in</h1>
        <p className="text-sm text-muted-foreground">Use the passkey saved on this device.</p>
      </div>

      <div className="flex flex-col gap-6">
        {supported ? (
          <Button className="w-full" onClick={signIn} disabled={loading}>
            <KeyRound data-icon="inline-start" />
            {loading ? "Signing in…" : "Sign in with passkey"}
          </Button>
        ) : (
          <p className="text-sm text-destructive">
            This browser doesn’t support passkeys. Try a different browser or device.
          </p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {showRecovery ? (
          <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <div className="flex flex-col gap-1">
              <p className="font-medium">Sign in by email instead</p>
              <p className="text-sm text-muted-foreground">
                No passkey on this device, or lost your device? We’ll email you a link to set one
                up.
              </p>
            </div>
            <input
              id="recovery-email"
              className="w-full rounded-md border bg-background px-3 py-2"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendRecovery();
              }}
              required
            />
            <Button
              className="w-full"
              onClick={() => void sendRecovery()}
              disabled={loading || !email.trim()}
            >
              {loading ? "Sending…" : "Email me a sign-in link"}
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setShowRecovery(true)}
          >
            No passkey on this device?
          </button>
        )}
      </div>
    </CenterCardLayout>
  );
}
