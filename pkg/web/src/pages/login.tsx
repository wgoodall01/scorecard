import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CenterCardLayout } from "@/components/center-card-layout";
import { PageTitle } from "@/App";
import { useAuth } from "@/lib/auth-context";
import { authService, browserSupportsWebAuthn } from "@/lib/auth";

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
      setError(signInError instanceof Error ? signInError.message : "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  }

  async function sendRecovery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  return (
    <CenterCardLayout>
      <PageTitle>Sign in · Scorecard</PageTitle>
      <div className="flex flex-col gap-1">
        <h1 className="font-medium">Sign in</h1>
        <p className="text-sm text-muted-foreground">Use the passkey saved on this device.</p>
      </div>

      {recoverySent ? (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-muted-foreground">
            If an account exists for <span className="font-medium text-foreground">{email}</span>,
            we’ve emailed a link to set up a passkey on this device.
          </p>
          {!isStandalone && (
            <aside className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm md:hidden">
              <p className="font-medium">Install Scorecard</p>
              <p className="mt-1 text-muted-foreground">
                In Safari, tap <Share aria-hidden="true" className="mx-0.5 inline size-4" /> Share,
                then choose <span className="font-medium text-foreground">Add to Home Screen</span>.
              </p>
            </aside>
          )}
        </div>
      ) : (
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
            <form className="flex flex-col gap-3" onSubmit={sendRecovery}>
              <label className="text-sm text-muted-foreground" htmlFor="recovery-email">
                No passkey on this device, or lost your device? Get a sign-in link by email.
              </label>
              <input
                id="recovery-email"
                className="w-full rounded-md border bg-transparent px-3 py-2"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <Button className="w-full" type="submit" variant="outline" disabled={loading}>
                {loading ? "Sending…" : "Email me a sign-in link"}
              </Button>
            </form>
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
      )}
    </CenterCardLayout>
  );
}
