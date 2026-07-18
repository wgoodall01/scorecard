import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Images, NotebookText } from "lucide-react";
import type { ScorecardStatus } from "api";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";
import { formatOutingDate, playerLabel } from "@/pages/outings";

export type ScorecardSummary = {
  id: string;
  createdAt: string;
};

export type ScorecardDetail = {
  id: string;
  createdAt: string;
  status: ScorecardStatus;
  error: string | null;
  uploader: { id: string; name: string | null; email: string | null };
  outings: { id: string; date: string; courseName: string }[];
};

function formatCapturedAt(createdAt: string) {
  return new Date(createdAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function StatusBadge({ status }: { status: ScorecardStatus }) {
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="secondary">{status === "pending" ? "Processing" : "Processed"}</Badge>;
}

// The photo behind a scorecard, fetched with the bearer token and rendered
// from a blob URL (a plain <img src> can't send the Authorization header) —
// the same dance as scorecard-gallery.tsx.
function useScorecardImage(scorecardId: string | null) {
  const { client } = useAuth();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!client || scorecardId === null) return;
    let cancelled = false;
    let created: string | null = null;
    void client.api.scorecard[":id"].image.$get({ param: { id: scorecardId } }).then(
      async (response) => {
        if (!response.ok || cancelled) return;
        created = URL.createObjectURL(await response.blob());
        if (!cancelled) setUrl(created);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [client, scorecardId]);

  return url;
}

function ScorecardThumb({ scorecardId }: { scorecardId: string }) {
  const url = useScorecardImage(scorecardId);
  return url ? (
    <img
      src={url}
      alt="Scorecard photo"
      className="h-14 w-20 shrink-0 rounded-lg border bg-muted object-cover"
    />
  ) : (
    <div className="h-14 w-20 shrink-0 animate-pulse rounded-lg border bg-muted" />
  );
}

// Reverse-chrono rows shared by the Scorecards page and the Me page's
// recent-scorecards section.
export function ScorecardList({ scorecards }: { scorecards: ScorecardSummary[] }) {
  return (
    <ul>
      {scorecards.map((card) => (
        <li key={card.id} className="border-b last:border-b-0">
          <Link
            to="/scorecards/$id"
            params={{ id: card.id }}
            className="flex items-center gap-3 p-5 py-3 transition-colors hover:bg-muted/50"
          >
            <ScorecardThumb scorecardId={card.id} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {formatCapturedAt(card.createdAt)}
              </span>
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ScorecardsPage() {
  const { client } = useAuth();
  const [scorecards, setScorecards] = useState<ScorecardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.api.scorecard.$get({ query: {} }).then(
      async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError("Unable to load your scorecards.");
          return;
        }
        setScorecards((await response.json()).scorecards);
      },
      () => {
        if (!cancelled) setError("Unable to load your scorecards.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <AppShell>
      <PageTitle>Scorecards · Scorecard</PageTitle>
      <PageHeading title="Scorecards" description="Every scorecard photo you've captured." />
      {!scorecards && !error && (
        <p className="text-sm text-muted-foreground">Loading scorecards…</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {scorecards && scorecards.length === 0 && (
        <section className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 p-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Images aria-hidden="true" />
          </div>
          <h2 className="mt-4 font-medium">No scorecards yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Capture a scorecard and it will show up here.
          </p>
        </section>
      )}
      {scorecards && scorecards.length > 0 && (
        <section className="rounded-xl border bg-card">
          <ScorecardList scorecards={scorecards} />
        </section>
      )}
    </AppShell>
  );
}

export function ScorecardDetailPage({ scorecardId }: { scorecardId: string }) {
  const { client } = useAuth();
  const [scorecard, setScorecard] = useState<ScorecardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imageUrl = useScorecardImage(scorecardId);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.api.scorecard[":id"].$get({ param: { id: scorecardId } }).then(
      async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError("This scorecard could not be found.");
          return;
        }
        setScorecard((await response.json()).scorecard);
      },
      () => {
        if (!cancelled) setError("Unable to load this scorecard.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, scorecardId]);

  return (
    <AppShell>
      <PageTitle>
        {scorecard ? `${formatCapturedAt(scorecard.createdAt)} · Scorecard` : "Scorecard"}
      </PageTitle>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm">
        <Link
          to="/scorecards"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          Scorecards
        </Link>
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">
          {scorecard ? formatCapturedAt(scorecard.createdAt) : "Scorecard"}
        </span>
      </nav>
      {!scorecard && !error && <p className="text-sm text-muted-foreground">Loading scorecard…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {scorecard && (
        <div className="flex flex-col gap-5">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">
                {formatCapturedAt(scorecard.createdAt)}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Captured by {playerLabel(scorecard.uploader)}
              </p>
            </div>
            <StatusBadge status={scorecard.status} />
          </header>

          {scorecard.error && <p className="text-sm text-destructive">{scorecard.error}</p>}

          {imageUrl ? (
            <img
              src={imageUrl}
              alt="Scorecard photo"
              className="max-h-[70dvh] w-full rounded-2xl border bg-muted object-contain"
            />
          ) : (
            <div className="aspect-[4/3] w-full animate-pulse rounded-2xl border bg-muted" />
          )}

          <section className="rounded-xl border bg-card">
            <div className="border-b p-5">
              <h2 className="font-medium">Outings</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The recorded rounds with scores read from this card.
              </p>
            </div>
            {scorecard.outings.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No outing has been recorded from this scorecard yet.
              </p>
            ) : (
              <ul>
                {scorecard.outings.map((outing) => (
                  <li key={outing.id} className="border-b last:border-b-0">
                    <Link
                      to="/outings/$id"
                      params={{ id: outing.id }}
                      className="flex items-center gap-3 p-5 py-3 transition-colors hover:bg-muted/50"
                    >
                      <NotebookText
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{outing.courseName}</span>
                        <span className="block text-sm text-muted-foreground">
                          {formatOutingDate(outing.date)}
                        </span>
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
