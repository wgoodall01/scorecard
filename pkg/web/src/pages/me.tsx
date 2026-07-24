import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  KeyRound,
  LogOut,
  Mail,
  Pencil,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { suggestDeviceName } from "@/lib/auth";
import { apiMutation, apiQuery, apiQueryKey } from "@/lib/query";
import { ScorecardList, type ScorecardSummary } from "@/pages/scorecards";

const RECENT_SCORECARDS = 5;

type Credential = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  current: boolean;
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// The signed-in user's passkeys: list, rename, remove, and add more (on this
// device now, or by emailing yourself an enroll link for another device).
function PasskeysCard() {
  const { enrollPasskey } = useAuth();
  const queryClient = useQueryClient();
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const credentialsQuery = useQuery(apiQuery(api.auth.credentials.$get));
  const credentials: Credential[] | null = credentialsQuery.data?.credentials ?? null;

  // Every change to the passkey list refetches it from the server.
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: apiQueryKey(api.auth.credentials.$get) });

  const inviteSelfMutation = useMutation({
    ...apiMutation(api.auth.invite.self.$post),
    onSuccess: () =>
      setInviteStatus("Check your email for a link to set up a passkey on another device."),
  });
  const renameMutation = useMutation({
    ...apiMutation(api.auth.credentials[":id"].$patch),
    onSuccess: async () => {
      setEditingId(null);
      await invalidate();
    },
  });
  const removeMutation = useMutation({
    ...apiMutation(api.auth.credentials[":id"].$delete),
    onSuccess: invalidate,
  });

  const busy =
    enrolling ||
    inviteSelfMutation.isPending ||
    renameMutation.isPending ||
    removeMutation.isPending;
  const error =
    enrollError ??
    inviteSelfMutation.error?.message ??
    renameMutation.error?.message ??
    removeMutation.error?.message ??
    (credentialsQuery.error !== null ? "Unable to load your passkeys." : null);

  // The browser ceremony isn't an API call — it's a WebAuthn dance that ends in
  // one — so it stays imperative, and just invalidates the list when it lands.
  async function addOnThisDevice() {
    setEnrolling(true);
    setEnrollError(null);
    setInviteStatus(null);
    try {
      await enrollPasskey({ name: suggestDeviceName() });
      await invalidate();
    } catch (addError) {
      setEnrollError(addError instanceof Error ? addError.message : "Unable to add a passkey.");
    } finally {
      setEnrolling(false);
    }
  }

  function emailAnotherDevice() {
    setEnrollError(null);
    setInviteStatus(null);
    inviteSelfMutation.mutate({});
  }

  function saveName(id: string) {
    const name = editingName.trim();
    if (!name) return;
    renameMutation.mutate({ param: { id }, json: { name } });
  }

  function remove(id: string) {
    if (!window.confirm("Remove this passkey? You won't be able to sign in with it anymore."))
      return;
    removeMutation.mutate({ param: { id } });
  }

  return (
    <section className="rounded-xl border bg-card">
      <div className="border-b p-5">
        <h2 className="font-medium">Passkeys</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Devices you can use to sign in. Add one for each phone or computer you use.
        </p>
      </div>

      {!credentials && <p className="p-5 text-sm text-muted-foreground">Loading passkeys…</p>}
      {credentials && credentials.length === 0 && (
        <p className="p-5 text-sm text-muted-foreground">No passkeys yet.</p>
      )}
      {credentials && credentials.length > 0 && (
        <ul className="divide-y">
          {credentials.map((cred) => (
            <li key={cred.id} className="flex items-center gap-3 p-5">
              <KeyRound aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
              {editingId === cred.id ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    className="w-full rounded-md border bg-transparent px-2 py-1 text-sm"
                    value={editingName}
                    maxLength={60}
                    autoFocus
                    onChange={(event) => setEditingName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveName(cred.id);
                      if (event.key === "Escape") setEditingId(null);
                    }}
                  />
                  <Button size="icon" variant="ghost" onClick={() => saveName(cred.id)}>
                    <Check className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setEditingId(null)}>
                    <X className="size-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{cred.name}</span>
                      {cred.current && (
                        <Badge variant="secondary" className="shrink-0">
                          This device
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Added {formatDate(cred.createdAt)}
                      {cred.lastUsedAt ? ` · Last used ${formatDate(cred.lastUsedAt)}` : ""}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Rename passkey"
                    onClick={() => {
                      setEditingId(cred.id);
                      setEditingName(cred.name);
                    }}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove passkey"
                    onClick={() => remove(cred.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 border-t p-5">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {inviteStatus && <p className="text-sm text-muted-foreground">{inviteStatus}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void addOnThisDevice()} disabled={busy}>
            <KeyRound data-icon="inline-start" />
            Add a passkey on this device
          </Button>
          <Button variant="outline" onClick={emailAnotherDevice} disabled={busy}>
            <Mail data-icon="inline-start" />
            Add another device
          </Button>
        </div>
      </div>
    </section>
  );
}

// The signed-in user's most recent captures, with the full list one tap away.
function RecentScorecards() {
  const scorecardsQuery = useQuery(
    apiQuery(api.scorecard.$get, { query: { limit: RECENT_SCORECARDS } }),
  );
  const scorecards: ScorecardSummary[] | null = scorecardsQuery.data?.scorecards ?? null;

  return (
    <section className="rounded-xl border bg-card">
      <div className="border-b p-5">
        <h2 className="font-medium">Scorecards</h2>
        <p className="mt-1 text-sm text-muted-foreground">Your most recent captures.</p>
      </div>
      {!scorecards && <p className="p-5 text-sm text-muted-foreground">Loading scorecards…</p>}
      {scorecards && scorecards.length === 0 && (
        <p className="p-5 text-sm text-muted-foreground">
          No scorecards yet — capture one and it will show up here.
        </p>
      )}
      {scorecards && scorecards.length > 0 && (
        <>
          <ScorecardList scorecards={scorecards} />
          <Link
            to="/scorecards"
            className="flex items-center justify-center gap-1 border-t p-3 text-sm font-medium transition-colors hover:bg-muted/50"
          >
            Show more
            <ChevronRight aria-hidden="true" className="size-4" />
          </Link>
        </>
      )}
    </section>
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
        {profile && <PasskeysCard />}
        <RecentScorecards />
        <Button variant="outline" className="self-start" onClick={handleSignOut}>
          <LogOut data-icon="inline-start" />
          Log out
        </Button>
      </div>
    </AppShell>
  );
}
