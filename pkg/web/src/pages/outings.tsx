import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Camera,
  ChevronRight,
  EllipsisVertical,
  GitMerge,
  NotebookText,
  Trash2,
  Trophy,
} from "lucide-react";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GolfScore } from "@/components/golf-score";
import { Score } from "@/components/score";
import { ScorecardGallery } from "@/components/scorecard-gallery";
import { useAuth } from "@/lib/auth-context";

export type OutingSummary = {
  id: string;
  date: string;
  course: { id: string; name: string };
  sets: { id: string; name: string }[];
  players: {
    id: string;
    name: string | null;
    email: string | null;
    total: number | null;
    incomplete: boolean;
  }[];
};

export type OutingDetail = {
  id: string;
  date: string;
  course: { id: string; name: string; location: string | null };
  players: { id: string; name: string | null; email: string | null }[];
  sets: {
    id: string;
    name: string;
    // The display layout (holes are per-tee rows; this is one tee's view).
    holes: { number: number; par: number }[];
    // scores[playerId][holeNumber] = strokes
    scores: Record<string, Record<number, number>>;
    // The tee each player played this nine from.
    tees: Record<string, { id: string; name: string }>;
    // parByPlayer[playerId][holeNumber] = par on the tee they played.
    parByPlayer: Record<string, Record<number, number>>;
  }[];
  scorecards: { id: string; createdAt: string }[];
};

// "Front 9" / "Back 9", derived from a nine's hole numbers — sets carry no
// stored disposition.
export function nineLabel(holeNumbers: number[]) {
  if (holeNumbers.length > 0 && holeNumbers.every((number) => number <= 9)) return "Front 9";
  if (holeNumbers.length > 0 && holeNumbers.every((number) => number >= 10)) return "Back 9";
  return "Nine";
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
              <Link className={buttonVariants({ className: "mt-5" })} to="/capture">
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
// A USGA-standard round assembled from an outing (the golfer page derives
// these from the handicap record): a 27-hole outing shows as an 18-hole and
// a 9-hole round rather than one 126-style total.
export type OutingListRound = {
  setNames: string[];
  strokes: number;
  holes: 9 | 18;
  counted: boolean;
};

export function OutingList({
  outings,
  highlightPlayerId,
  roundsByOuting,
}: {
  outings: OutingSummary[];
  highlightPlayerId?: string;
  // Per-outing standard rounds for the highlighted player; rounds that count
  // toward the current handicap are starred.
  roundsByOuting?: ReadonlyMap<string, OutingListRound[]>;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <ul>
        {outings.map((entry) => {
          const highlighted = highlightPlayerId
            ? (entry.players.find((player) => player.id === highlightPlayerId) ?? null)
            : null;
          const rounds = roundsByOuting?.get(entry.id);
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
                    rounds && rounds.length > 0 ? (
                      <div className="flex shrink-0 flex-col items-end">
                        {rounds.map((round, index) => (
                          <p
                            key={index}
                            className="text-lg font-semibold"
                            title={`${round.setNames.join(" + ")} · ${round.holes} holes`}
                          >
                            <Score value={round.strokes} inHandicap={round.counted} />
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="shrink-0 text-lg font-semibold">
                        <Score value={highlighted.total} incomplete={highlighted.incomplete} />
                      </p>
                    )
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
                  {entry.players.map((player, index) => (
                    <Fragment key={player.id}>
                      {index > 0 && ", "}
                      {playerLabel(player)}
                      {player.total !== null && (
                        <>
                          {" ("}
                          <Score value={player.total} incomplete={player.incomplete} />
                          {")"}
                        </>
                      )}
                    </Fragment>
                  ))}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// The tee(s) a player hit from across the outing's nines, for the
// leaderboard's subtitle — usually one name, but a mixed-tee day lists each.
function playerTeeLabel(outing: OutingDetail, playerId: string) {
  const names = [
    ...new Set(
      outing.sets
        .map((set) => set.tees[playerId]?.name)
        .filter((name): name is string => name !== undefined),
    ),
  ];
  return names.length > 0 ? `${names.join(" · ")} tees` : "Tee not recorded";
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
  const { client, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [outing, setOuting] = useState<OutingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeCandidates, setMergeCandidates] = useState<OutingSummary[]>([]);
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadOuting = useCallback(async () => {
    if (!client) return;
    try {
      const response = await client.api.outings[":id"].$get({ param: { id: outingId } });
      if (!response.ok) {
        setError("This outing could not be found.");
        return;
      }
      const { outing: loadedOuting } = await response.json();
      setOuting(loadedOuting);
    } catch {
      setError("Unable to load this outing.");
    }
  }, [client, outingId]);

  useEffect(() => {
    void loadOuting();
  }, [loadOuting]);

  // Auto-suggest merges: other outings at this course on the same date are
  // almost certainly the same round captured on separate scorecards.
  useEffect(() => {
    if (!client || !outing) return;
    let cancelled = false;
    void client.api.outings
      .$get({ query: { courseId: outing.course.id } })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const { outings } = await response.json();
        if (cancelled) return;
        setMergeCandidates(
          outings.filter((entry) => entry.date === outing.date && entry.id !== outing.id),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, outing]);

  async function merge(sourceId: string) {
    if (!client) return;
    setMerging(sourceId);
    setMergeError(null);
    try {
      const response = await client.api.outings[":id"].merge.$post({
        param: { id: outingId },
        json: { outingId: sourceId },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Unable to merge these outings.");
      }
      await loadOuting();
    } catch (mergeFailure) {
      setMergeError(
        mergeFailure instanceof Error ? mergeFailure.message : "Unable to merge these outings.",
      );
    } finally {
      setMerging(null);
    }
  }

  async function deleteOuting() {
    if (!client) return;
    if (!window.confirm("Delete this outing and all its scores? This can't be undone.")) return;
    setDeleting(true);
    try {
      const response = await client.api.outings[":id"].$delete({ param: { id: outingId } });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Unable to delete this outing.");
      }
      await navigate({ to: "/outings" });
    } catch (deleteFailure) {
      setError(deleteFailure instanceof Error ? deleteFailure.message : "Unable to delete.");
      setDeleting(false);
    }
  }

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
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">
                {formatOutingDate(outing.date)}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {outing.course.name}
                {outing.course.location && ` · ${outing.course.location}`}
              </p>
            </div>
            {isAdmin && (
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      aria-label="Outing actions"
                      className="size-9 shrink-0 p-0"
                    />
                  }
                >
                  <EllipsisVertical aria-hidden="true" />
                </PopoverTrigger>
                <PopoverContent align="end" className="w-48 p-1">
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={deleteOuting}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    {deleting ? "Deleting…" : "Delete outing"}
                  </button>
                </PopoverContent>
              </Popover>
            )}
          </header>

          {mergeCandidates.length > 0 && (
            <section className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/5 p-5">
              <h2 className="flex items-center gap-2 font-medium">
                <GitMerge aria-hidden="true" className="size-4" />
                Same-day outings
              </h2>
              <p className="text-sm text-muted-foreground">
                {mergeCandidates.length === 1 ? "Another outing was" : "Other outings were"}{" "}
                recorded at {outing.course.name} on this date — likely the same round on separate
                scorecards. Merging pulls {mergeCandidates.length === 1 ? "its" : "their"} scores
                into this outing.
              </p>
              <ul className="flex flex-col gap-2">
                {mergeCandidates.map((candidate) => (
                  <li
                    key={candidate.id}
                    className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {candidate.players.map((player, index) => (
                          <Fragment key={player.id}>
                            {index > 0 && ", "}
                            {playerLabel(player)}
                            {player.total !== null && (
                              <>
                                {" ("}
                                <Score value={player.total} incomplete={player.incomplete} />
                                {")"}
                              </>
                            )}
                          </Fragment>
                        ))}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {candidate.sets.map((set) => set.name).join(" · ") || "No scores yet"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={merging !== null}
                      onClick={() => void merge(candidate.id)}
                    >
                      <GitMerge data-icon="inline-start" />
                      {merging === candidate.id ? "Merging…" : "Merge in"}
                    </Button>
                  </li>
                ))}
              </ul>
              {mergeError && <p className="text-sm text-destructive">{mergeError}</p>}
            </section>
          )}

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

// The golfers table doubles as the round leaderboard: rows sort by total
// strokes ascending (best round first) and the winning complete round gets a
// trophy (ties share it). Incomplete rounds sort after complete ones and
// never win — their totals aren't comparable.
function GolfersTable({ outing }: { outing: OutingDetail }) {
  const { totalHoles, totals, anyIncomplete } = computeRoundTotals(outing);

  const ranked = [...totals].sort((a, b) => {
    if ((a.total === null) !== (b.total === null)) return a.total === null ? 1 : -1;
    if (a.total === null || b.total === null) return 0;
    if (a.incomplete !== b.incomplete) return a.incomplete ? 1 : -1;
    return a.total - b.total;
  });

  function isWinner(entry: (typeof totals)[number]): boolean {
    if (entry.total === null || entry.incomplete) return false;
    return !totals.some(
      (other) => other.total !== null && !other.incomplete && other.total < (entry.total ?? 0),
    );
  }

  const hasWinner = ranked.some((entry) => isWinner(entry));

  return (
    <section className="rounded-xl border bg-card">
      <div className="border-b p-5">
        <h2 className="font-medium">Golfers</h2>
      </div>
      <ul className="flex flex-col">
        {ranked.map((entry) => {
          const { player, total, incomplete } = entry;
          return (
            <li key={player.id} className="border-b last:border-b-0">
              <Link
                to="/golfers/$id"
                params={{ id: player.id }}
                className="flex items-center justify-between gap-3 p-5 py-3 transition-colors hover:bg-muted/50"
              >
                {hasWinner && (
                  <span className="flex w-7 shrink-0 items-center" aria-hidden={!isWinner(entry)}>
                    {isWinner(entry) && (
                      <Trophy
                        aria-label="First place"
                        className="size-5 text-amber-600 dark:text-amber-400"
                      />
                    )}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{playerLabel(player)}</span>
                  <span className="block text-sm text-muted-foreground">
                    {playerTeeLabel(outing, player.id)}
                  </span>
                </span>
                <span className="shrink-0 text-lg font-semibold">
                  <Score value={total} incomplete={incomplete} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {anyIncomplete && (
        <p className="border-t p-5 py-3 text-xs text-muted-foreground">
          <sup>+</sup> didn't play all {totalHoles} holes in this outing — the total only counts the
          holes with a recorded score.
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
        <Badge variant="secondary">{nineLabel(set.holes.map((hole) => hole.number))}</Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="w-14 py-3 pr-2 pl-5 font-medium">Hole</th>
              <th className="w-10 px-2 py-3 font-medium">Par</th>
              {setPlayers.map((player) => (
                <th key={player.id} className="p-3 pr-5 text-right font-medium">
                  {playerLabel(player)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {set.holes.map((hole) => (
              <tr key={hole.number} className="border-b">
                <td className="w-14 py-3 pr-2 pl-5 font-medium">{hole.number}</td>
                <td className="w-10 px-2 py-3 text-muted-foreground">{hole.par}</td>
                {setPlayers.map((player) => {
                  const value = set.scores[player.id]?.[hole.number];
                  // Notation (birdie circles, bogey squares) is judged
                  // against the par of the tee THIS player hit from.
                  const par = set.parByPlayer[player.id]?.[hole.number] ?? hole.par;
                  return (
                    <td key={player.id} className="p-3 pr-5 text-right tabular-nums">
                      <GolfScore score={value ?? null} par={par} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="w-14 py-3 pr-2 pl-5 font-medium">Total</td>
              <td className="w-10 px-2 py-3" />
              {setPlayers.map((player) => (
                <td key={player.id} className="p-3 pr-5 text-right font-medium">
                  <Score value={totalFor(player.id)} />
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
