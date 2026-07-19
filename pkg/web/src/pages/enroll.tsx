import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CenterCardLayout } from "@/components/center-card-layout";
import { PageTitle } from "@/App";
import { useAuth } from "@/lib/auth-context";
import { authService, createApiClient, suggestDeviceName } from "@/lib/auth";

type InviteInfo = { name: string | null; email: string | null };

export function EnrollPage({ token }: { token: string }) {
  const { enrollPasskey } = useAuth();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState(() => suggestDeviceName());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError("This link is incomplete.");
      return;
    }
    let cancelled = false;
    void createApiClient()
      .api.auth.invite[":token"].$get({ param: { token } })
      .then(
        async (response) => {
          if (cancelled) return;
          if (!response.ok) {
            setLoadError(
              response.status === 410
                ? "This link has expired. Request a new one from the sign-in page."
                : "This link is invalid. Request a new one from the sign-in page.",
            );
            return;
          }
          setInvite((await response.json()).invite);
        },
        () => {
          if (!cancelled) setLoadError("Unable to check this link. Please try again.");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function createPasskey() {
    setSubmitting(true);
    setError(null);
    try {
      await enrollPasskey({ inviteToken: token, name: deviceName.trim() || "Passkey" });
      await navigate({ href: authService.getReturnTo(), replace: true });
    } catch (enrollError) {
      setError(enrollError instanceof Error ? enrollError.message : "Unable to set up a passkey.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CenterCardLayout>
      <PageTitle>Set up your passkey · Scorecard</PageTitle>
      {loadError ? (
        <div className="flex flex-col gap-4">
          <h1 className="font-medium">Set up your passkey</h1>
          <p className="text-sm text-destructive">{loadError}</p>
          <Link
            to="/login"
            search={{ returnTo: "/" }}
            className="text-sm underline underline-offset-4"
          >
            Back to sign in
          </Link>
        </div>
      ) : !invite ? (
        <p className="text-sm text-muted-foreground">Checking your link…</p>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="font-medium">Set up your passkey</h1>
            <p className="text-sm text-muted-foreground">
              {invite.name ? `Welcome, ${invite.name}. ` : ""}Create a passkey on this device to
              sign in — no password to remember.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm text-muted-foreground" htmlFor="device-name">
              Name this device
            </label>
            <input
              id="device-name"
              className="w-full rounded-md border bg-transparent px-3 py-2"
              value={deviceName}
              maxLength={60}
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" onClick={createPasskey} disabled={submitting}>
            <KeyRound data-icon="inline-start" />
            {submitting ? "Setting up…" : "Create passkey"}
          </Button>
        </div>
      )}
    </CenterCardLayout>
  );
}
