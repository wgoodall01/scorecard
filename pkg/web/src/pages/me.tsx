import { useNavigate } from "@tanstack/react-router";
import { LogOut, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { useAuth } from "@/lib/auth-context";

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
