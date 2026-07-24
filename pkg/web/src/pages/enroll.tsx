import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CenterCardLayout } from "@/components/center-card-layout";
import { PageTitle } from "@/App";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { ApiError, authService, suggestDeviceName } from "@/lib/auth";
import { apiQuery } from "@/lib/query";

export function EnrollPage({ token }: { token: string }) {
  const { enrollPasskey } = useAuth();
  const navigate = useNavigate();
  const [deviceName, setDeviceName] = useState(() => suggestDeviceName());

  const inviteQuery = useQuery({
    ...apiQuery(api.auth.invite[":token"].$get, { param: { token } }),
    enabled: token !== "",
    retry: false,
  });
  const invite = inviteQuery.data?.invite ?? null;
  const loadError =
    token === ""
      ? "This link is incomplete."
      : inviteQuery.error instanceof ApiError
        ? inviteQuery.error.status === 410
          ? "This link has expired. Request a new one from the sign-in page."
          : "This link is invalid. Request a new one from the sign-in page."
        : inviteQuery.error !== null
          ? "Unable to check this link. Please try again."
          : null;

  const enrollMutation = useMutation({
    mutationFn: () => enrollPasskey({ inviteToken: token, name: deviceName.trim() || "Passkey" }),
    onSuccess: () => navigate({ href: authService.getReturnTo(), replace: true }),
  });
  const submitting = enrollMutation.isPending;
  const error = enrollMutation.error?.message ?? null;

  function createPasskey() {
    enrollMutation.mutate();
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
