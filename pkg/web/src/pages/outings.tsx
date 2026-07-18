import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Camera, ChevronRight, NotebookText } from "lucide-react";
import type { Tee } from "api";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScorecardGallery } from "@/components/scorecard-gallery";
import { useAuth } from "@/lib/auth-context";
import { TEE_LABELS } from "@/lib/tees";

export type OutingSummary = {
  id: string;
  date: string;
  course: { id: string; name: string };
  sets: { id: string; name: string }[];
  players: { id: string; name: string | null; email: string | null; total: number | null }[];
};

export type OutingDetail = {
  id: string;
  date: string;
  course: { id: string; name: string; location: string | null };
  players: { id: string; name: string | null; email: string | null; tee: Tee | null }[];
  sets: {
    id: string;
    name: string;
    disposition: "front" | "back" | null;
    holes: { id: string; number: number; name: string | null; par: number }[];
    scores: Record<string, Record<string, number>>;
  }[];
  scorecards: { id: string; createdAt: string }[];
};

export function dispositionLabel(disposition: "front" | "back" | null) {
  return disposition === "front" ? "Front 9" : disposition === "back" ? "Back 9" : "Other";
}

type CourseOption = {
  id: string;
  name: string;
  sets: { id: string; name: string }[];
};

export function playerLabel(player: { name: string | null; email: string | null }) {
  return player.name ?? player.email ?? "Unnamed golfer";
}

export function formatOutingDate(date: string) {
  // The date is naive ("YYYY-MM-DD"); anchor it to noon so the formatter
  // never slides it across midnight into a neighboring day.
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function OutingsPage() {
  const { client } = useAuth();
  const [outings, setOutings] = useState<OutingSummary[] | null>(null);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [players, setPlayers] = useState<
    { id: string; name: string | null; email: string | null }[]
  >([]);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [courseSetId, setCourseSetId] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);

  const loadOutings = useCallback(async () => {
    if (!client) return;
    const response = await client.api.outings.$get({
      query: {
        courseId: courseId ?? undefined,
        courseSetId: courseSetId ?? undefined,
        playerId: playerId ?? undefined,
      },
    });
    if (!response.ok) return;
    const { outings: loadedOutings } = await response.json();
    setOutings(loadedOutings);
  }, [client, courseId, courseSetId, playerId]);

  useEffect(() => {
    void loadOutings();
  }, [loadOutings]);

  useEffect(() => {
    if (!client) return;
    void client.api.courses.$get().then(async (response) => {
      if (response.ok) setCourses((await response.json()).courses);
    });
    void client.api.golfers.$get().then(async (response) => {
      if (response.ok) setPlayers((await response.json()).golfers);
    });
  }, [client]);

  const setOptions = useMemo(() => {
    const relevantCourses = courseId ? courses.filter((course) => course.id === courseId) : courses;
    return relevantCourses.flatMap((course) =>
      course.sets.map((set) => ({
        id: set.id,
        label: courseId ? set.name : `${course.name} · ${set.name}`,
      })),
    );
  }, [courses, courseId]);

  const hasFilters = courseId !== null || courseSetId !== null || playerId !== null;

  return (
    <AppShell>
      <PageTitle>Outings · Scorecard</PageTitle>
      <PageHeading title="Outings" description="Every round your group has recorded." />
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-course" className="text-xs text-muted-foreground">
              Course
            </Label>
            <Select
              items={[
                { value: null, label: "All courses" },
                ...courses.map((course) => ({ value: course.id, label: course.name })),
              ]}
              value={courseId}
              onValueChange={(value) => {
                setCourseId(value as string | null);
                setCourseSetId(null);
              }}
            >
              <SelectTrigger id="filter-course" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={null}>All courses</SelectItem>
                {courses.map((course) => (
                  <SelectItem key={course.id} value={course.id}>
                    {course.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-set" className="text-xs text-muted-foreground">
              Nine
            </Label>
            <Select
              items={[
                { value: null, label: "All nines" },
                ...setOptions.map((set) => ({ value: set.id, label: set.label })),
              ]}
              value={courseSetId}
              onValueChange={(value) => setCourseSetId(value as string | null)}
            >
              <SelectTrigger id="filter-set" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={null}>All nines</SelectItem>
                {setOptions.map((set) => (
                  <SelectItem key={set.id} value={set.id}>
                    {set.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-player" className="text-xs text-muted-foreground">
              Golfer
            </Label>
            <Select
              items={[
                { value: null, label: "All golfers" },
                ...players.map((player) => ({ value: player.id, label: playerLabel(player) })),
              ]}
              value={playerId}
              onValueChange={(value) => setPlayerId(value as string | null)}
            >
              <SelectTrigger id="filter-player" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={null}>All golfers</SelectItem>
                {players.map((player) => (
                  <SelectItem key={player.id} value={player.id}>
                    {playerLabel(player)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {!outings && <p className="text-sm text-muted-foreground">Loading outings…</p>}
        {outings && outings.length === 0 && (
          <section className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <NotebookText aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-medium">
              {hasFilters ? "No matching outings" : "No outings yet"}
            </h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {hasFilters
                ? "Try clearing the filters above."
                : "Capture your first scorecard to begin building your history."}
            </p>
            {!hasFilters && (
              <Link className={buttonVariants({ className: "mt-5" })} to="/">
                <Camera data-icon="inline-start" />
                Capture a scorecard
              </Link>
            )}
          </section>
        )}
        {outings && outings.length > 0 && <OutingList outings={outings} />}
      </div>
    </AppShell>
  );
}

// With `highlightPlayerId`, each item leads with that player's round score
// in the top right (the golfer-page view); otherwise the date sits there.
export function OutingList({
  outings,
  highlightPlayerId,
}: {
  outings: OutingSummary[];
  highlightPlayerId?: string;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <ul>
        {outings.map((entry) => {
          const highlighted = highlightPlayerId
            ? (entry.players.find((player) => player.id === highlightPlayerId) ?? null)
            : null;
          return (
            <li key={entry.id} className="border-b last:border-b-0">
              <Link
                to="/outings/$id"
                params={{ id: entry.id }}
                className="flex flex-col gap-1 p-5 transition-colors hover:bg-muted/50"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{entry.course.name}</p>
                    {highlighted && (
                      <p className="text-sm text-muted-foreground">
                        {formatOutingDate(entry.date)}
                      </p>
                    )}
                  </div>
                  {highlighted ? (
                    <p className="shrink-0 text-lg font-semibold tabular-nums">
                      {highlighted.total ?? "–"}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">{formatOutingDate(entry.date)}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {entry.sets.map((set) => (
                    <Badge key={set.id} variant="secondary">
                      {set.name}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  {entry.players
                    .map(
                      (player) =>
                        `${playerLabel(player)}${player.total !== null ? ` (${player.total})` : ""}`,
                    )
                    .join(", ")}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Each player's total strokes across every nine in the outing, flagged when
// they didn't play all of the outing's holes.
function computeRoundTotals(outing: OutingDetail) {
  const totalHoles = outing.sets.reduce((count, set) => count + set.holes.length, 0);
  const totals = outing.players.map((player) => {
    const cells = outing.sets.flatMap((set) => Object.values(set.scores[player.id] ?? {}));
    return {
      player,
      total: cells.length > 0 ? cells.reduce((sum, value) => sum + value, 0) : null,
      incomplete: cells.length > 0 && cells.length < totalHoles,
    };
  });
  return { totalHoles, totals, anyIncomplete: totals.some((entry) => entry.incomplete) };
}

export function OutingDetailPage({ outingId }: { outingId: string }) {
  const { client } = useAuth();
  const [outing, setOuting] = useState<OutingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.api.outings[":id"].$get({ param: { id: outingId } }).then(
      async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError("This outing could not be found.");
          return;
        }
        const { outing: loadedOuting } = await response.json();
        setOuting(loadedOuting);
      },
      () => {
        if (!cancelled) setError("Unable to load this outing.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, outingId]);

  return (
    <AppShell>
      <PageTitle>
        {outing ? `${formatOutingDate(outing.date)} · Scorecard` : "Outing · Scorecard"}
      </PageTitle>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm">
        <Link
          to="/outings"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          Outings
        </Link>
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">
          {outing ? `${formatOutingDate(outing.date)}, ${outing.course.name}` : "Outing"}
        </span>
      </nav>
      {!outing && !error && <p className="text-sm text-muted-foreground">Loading outing…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {outing && (
        <div className="flex flex-col gap-6">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">
              {formatOutingDate(outing.date)}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {outing.course.name}
              {outing.course.location && ` · ${outing.course.location}`}
            </p>
          </header>

          <GolfersTable outing={outing} />

          {outing.sets.map((set) => (
            <ScorecardTable key={set.id} set={set} players={outing.players} />
          ))}

          {outing.scorecards.length > 0 && (
            <section className="rounded-xl border bg-card">
              <div className="border-b p-5">
                <h2 className="font-medium">Scorecards</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  The captured cards these scores were read from.
                </p>
              </div>
              <ScorecardGallery scorecards={outing.scorecards} />
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}

// The golfers table doubles as the round leaderboard: each row links to the
// golfer's page, with their tee and total round score (rightmost column).
function GolfersTable({ outing }: { outing: OutingDetail }) {
  const { totalHoles, totals, anyIncomplete } = computeRoundTotals(outing);

  return (
    <section className="rounded-xl border bg-card">
      <div className="border-b p-5">
        <h2 className="font-medium">Golfers</h2>
      </div>
      <ul className="flex flex-col">
        {totals.map(({ player, total, incomplete }) => (
          <li key={player.id} className="border-b last:border-b-0">
            <Link
              to="/golfers/$id"
              params={{ id: player.id }}
              className="flex items-center justify-between gap-3 p-5 py-3 transition-colors hover:bg-muted/50"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{playerLabel(player)}</span>
                <span className="block text-sm text-muted-foreground">
                  {player.tee ? `${TEE_LABELS[player.tee]} tees` : "Tee not recorded"}
                </span>
              </span>
              <span className="shrink-0 text-lg font-semibold tabular-nums">
                {total ?? "–"}
                {incomplete && "*"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {anyIncomplete && (
        <p className="border-t p-5 py-3 text-xs text-muted-foreground">
          * didn't play all {totalHoles} holes in this outing — the total only counts the holes with
          a recorded score.
        </p>
      )}
    </section>
  );
}

function ScorecardTable({
  set,
  players,
}: {
  set: OutingDetail["sets"][number];
  players: OutingDetail["players"];
}) {
  // Only show columns for golfers who actually have scores on this set.
  const setPlayers = players.filter((player) => set.scores[player.id]);

  function totalFor(playerId: string) {
    const cells = set.scores[playerId] ?? {};
    const values = Object.values(cells);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
  }

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b p-5">
        <h2 className="font-medium">{set.name}</h2>
        <Badge variant="secondary">{dispositionLabel(set.disposition)}</Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="p-3 pl-5 font-medium">Hole</th>
              <th className="p-3 font-medium">Par</th>
              {setPlayers.map((player) => (
                <th key={player.id} className="p-3 pr-5 text-right font-medium">
                  {playerLabel(player)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {set.holes.map((hole) => (
              <tr key={hole.id} className="border-b">
                <td className="p-3 pl-5 font-medium">
                  {hole.number}
                  {hole.name && (
                    <span className="ml-2 text-xs text-muted-foreground">{hole.name}</span>
                  )}
                </td>
                <td className="p-3 text-muted-foreground">{hole.par}</td>
                {setPlayers.map((player) => {
                  const value = set.scores[player.id]?.[hole.id];
                  return (
                    <td key={player.id} className="p-3 pr-5 text-right tabular-nums">
                      {value ?? "–"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="p-3 pl-5 font-medium">Total</td>
              <td className="p-3" />
              {setPlayers.map((player) => (
                <td key={player.id} className="p-3 pr-5 text-right font-medium tabular-nums">
                  {totalFor(player.id) ?? "–"}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
