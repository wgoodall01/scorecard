import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, LogOut, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { useAuth } from "@/lib/auth-context";
import { ScorecardList, type ScorecardSummary } from "@/pages/scorecards";

const RECENT_SCORECARDS = 5;

// The signed-in user's most recent captures, with the full list one tap away.
function RecentScorecards() {
  const { client } = useAuth();
  const [scorecards, setScorecards] = useState<ScorecardSummary[] | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.api.scorecard.$get({ query: { limit: RECENT_SCORECARDS } }).then(
      async (response) => {
        if (!response.ok || cancelled) return;
        setScorecards((await response.json()).scorecards);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

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
        <RecentScorecards />
        <Button variant="outline" className="self-start" onClick={handleSignOut}>
          <LogOut data-icon="inline-start" />
          Log out
        </Button>
      </div>
    </AppShell>
  );
}
