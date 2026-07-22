import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  GitMerge,
  RefreshCcw,
  Send,
  TriangleAlert,
  Trophy,
  X,
} from "lucide-react";
import type {
  ExtractDataSchema,
  MatchedData,
  PlayerBoxSchema,
  SubmitOutingRequestSchema,
} from "api";
import { GolfScore } from "@/components/golf-score";
import { ImageExpand } from "@/components/image-expand";
import { InitialsThumbnail } from "@/components/initials-thumbnail";
import { ResponsiveSelect } from "@/components/responsive-select";
import { Score } from "@/components/score";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { allCoursesQuery, allGolfersQuery } from "@/lib/queries";
import { apiMutation, apiQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { Golfer } from "@/pages/golfers";
import { sortTees, teeLabel, type CourseTee } from "@/pages/courses";
import { formatOutingDate, playerLabel, type OutingDetail } from "@/pages/outings";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A stable empty fallback, so a still-loading registry doesn't hand the memos
// below a fresh array identity on every render.
const NO_RECORDS: never[] = [];

// Golfer-picker sentinel for "leave this written name off the round" — no
// real golfer id (a uuid) can collide with it.
const IGNORE_PLAYER = "__ignore__";

type CourseWithSets = {
  id: string;
  name: string;
  location: string | null;
  sets: {
    id: string;
    name: string;
    courseId: string;
    tees: CourseTee[];
  }[];
};

type CourseSetOption = CourseWithSets["sets"][number];

// Where a written name appeared on the card, with the box around the scrawl.
type PlayerOccurrence = { location: string; bbox: PlayerBoxSchema | null };

type PlayerReview = {
  name: string;
  playerId: string | null;
  // True when the user chose to ignore this written name — its score columns
  // are left out of the review and nothing is recorded for it (a guest who
  // isn't in the league, a stray column the extraction invented, …).
  ignored: boolean;
  // The model's alternative readings of the scrawl, and every place this name
  // was seen — both shown in the golfer picker to disambiguate a hard read.
  guesses: string[];
  occurrences: PlayerOccurrence[];
};

// Collapse the per-nine player rows to one entry per distinct written name (in
// first-seen order), merging alternative readings and collecting where each
// appeared ("Player 2 on Blue Spruce") with its bounding box.
function distinctPlayers(
  extracted: ExtractDataSchema,
): Omit<PlayerReview, "playerId" | "ignored">[] {
  const byName = new Map<string, Omit<PlayerReview, "playerId" | "ignored">>();
  for (const nine of extracted.nines) {
    const nineLabel =
      nine.nineName ??
      (nine.holes.length > 0 && nine.holes.every((hole) => hole.hole >= 10) ? "Back 9" : "Front 9");
    nine.players.forEach((player, index) => {
      const entry = byName.get(player.name) ?? { name: player.name, guesses: [], occurrences: [] };
      entry.guesses = [...new Set([...entry.guesses, ...player.guesses])];
      entry.occurrences.push({
        location: `Player ${index + 1} on ${nineLabel}`,
        bbox: player.bbox,
      });
      byName.set(player.name, entry);
    });
  }
  return [...byName.values()];
}

// The user's verdict on a written-vs-computed totals comparison. Every
// section with a handwritten total must have one before submitting.
type TotalsChoice = "agree" | "wrong" | "corrected";

type NineReview = {
  nineName: string | null;
  playerNames: string[];
  holes: { number: number; par: number }[]; // as extracted from the card
  scores: (number | null)[][]; // [holeIndex][playerIndex]
  writtenTotals: (number | null)[]; // per playerIndex, as handwritten
  courseSetId: string | null;
  // The course_set_tee each player hit this nine from, per playerIndex.
  // Auto-defaulted (preferred-tee type, else standard, else the first tee;
  // a merge candidate's recorded tee wins) whenever the set changes.
  teeIds: (string | null)[];
  totalsChoice: TotalsChoice | null;
  // True only while this nine's scores are exactly as scanned AND those scanned
  // scores summed to the scanned written totals. Editing any score clears it —
  // so "all OK" is offered only when the card checked out untouched, never
  // after the user corrected a score into agreement.
  pristineMatch: boolean;
};

// The default tee for a golfer on a set: the tee already recorded for them
// on the merge candidate's same nine, else — among the tees of the golfer's
// gender (null gender falls back to the men's tees) — the one matching their
// profile's preferred type, else the standard-type tee, else the longest.
function defaultTeeFor(
  set: CourseSetOption,
  golfer: Golfer | undefined,
  mergeSet?: OutingDetail["sets"][number],
): CourseTee | null {
  const merged = golfer ? mergeSet?.tees[golfer.id] : undefined;
  const fromMerge = merged ? set.tees.find((tee) => tee.id === merged.id) : undefined;
  if (fromMerge) return fromMerge;

  // Restrict to the golfer's gender (defaulting to men's); if the course lists
  // no tees for that gender, consider them all.
  const wantGender = golfer?.gender ?? "m";
  const genderTees = set.tees.filter((tee) => tee.gender === wantGender);
  const pool = genderTees.length > 0 ? genderTees : set.tees;

  const preferred = golfer?.preferredTee
    ? pool.find((tee) => tee.type === golfer.preferredTee)
    : undefined;
  return preferred ?? pool.find((tee) => tee.type === "standard") ?? sortTees(pool)[0] ?? null;
}

function localIsoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Best-effort parse of whatever was handwritten on the card ("7/17",
// "7-17-26", "July 17 2026"…); falls back to today.
export function parseExtractedDate(raw: string | null): string {
  const today = new Date();
  if (raw) {
    const numeric = /^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/.exec(raw.trim());
    if (numeric) {
      const year =
        numeric[3] === undefined
          ? today.getFullYear()
          : numeric[3].length === 2
            ? 2000 + Number(numeric[3])
            : Number(numeric[3]);
      const parsed = new Date(year, Number(numeric[1]) - 1, Number(numeric[2]));
      if (!Number.isNaN(parsed.getTime())) return localIsoDate(parsed);
    }
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
      return localIsoDate(parsed);
    }
  }
  return localIsoDate(today);
}

function defaultNineName(nine: { nineName: string | null; holes: { number: number }[] }): string {
  if (nine.nineName) return nine.nineName;
  const back = nine.holes.length > 0 && nine.holes.every((hole) => hole.number >= 10);
  return back ? "Back 9" : "Front 9";
}

// "1:4,2:5,…" — mirrors the matching agent's exact-phase fingerprint, used to
// auto-pick a set when the user switches courses.
function parSignature(holes: { number: number; par: number }[]): string {
  return [...holes]
    .sort((a, b) => a.number - b.number)
    .map((hole) => `${hole.number}:${hole.par}`)
    .join(",");
}

function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}

// True when there's at least one handwritten total and every one of them
// equals the summed scores — the case that needs no human ruling, so the
// review pre-selects "Totals agree" instead of demanding a click.
function writtenTotalsMatch(written: (number | null)[], computed: (number | null)[]): boolean {
  if (!written.some((value) => value !== null)) return false;
  return written.every((value, index) => value === null || value === computed[index]);
}

type TotalsRow = { label: string; written: number | null; computed: number | null };

// null = section fine (or nothing handwritten to check); otherwise the
// problem message blocking submit.
function totalsProblem(section: string, rows: TotalsRow[], choice: TotalsChoice | null) {
  const checked = rows.filter((row) => row.written !== null);
  if (checked.length === 0) return null;
  const matches = checked.every((row) => row.computed === row.written);
  // The silently confirmed state: only the initializers ever set "agree", so
  // agree + matches means the totals checked out at extraction and still do.
  if (matches && choice === "agree") return null;
  if (choice === null || choice === "agree") {
    return matches
      ? `Confirm the written totals for ${section}.`
      : `${section}: the written totals don't match the summed scores — ` +
          "fix a score or mark the written totals as wrong.";
  }
  if (choice === "corrected" && !matches) {
    return (
      `${section}: the written totals still don't match the summed scores — ` +
      "fix a score or mark the written totals as wrong."
    );
  }
  if (choice === "wrong" && matches) {
    return `${section}: the totals now match — mark “I corrected a score” instead.`;
  }
  return null;
}

// The review flow is stroke-and-typography sections, not nested cards: each
// section opens with a heading and is divided from the previous one by a
// top border (suppressed on the first child so the flow doesn't start with
// a floating rule).
function ReviewSection({
  title,
  description,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("flex flex-col gap-4 border-t pt-6 first:border-t-0 first:pt-0", className)}
    >
      {(title !== undefined || description !== undefined) && (
        <div className="flex flex-col gap-1">
          {title !== undefined && <h2 className="font-heading text-base font-medium">{title}</h2>}
          {description !== undefined && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

// The validation + action buttons stick to the bottom of the viewport (above
// the mobile tab bar), top divider included, so submit is always reachable.
// Negative horizontal margins mirror the main section's padding (px-5 /
// md:px-10, same trick as the capture stepper header) so scrolling content
// can't bleed through beside the bar.
function StickyActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] -mx-5 flex flex-col gap-3 border-t bg-background px-5 pt-4 pb-3 md:bottom-0 md:-mx-10 md:px-10">
      {children}
    </div>
  );
}

function TotalsCheck({
  rows,
  choice,
  onChoice,
  canAffirm,
}: {
  rows: TotalsRow[];
  choice: TotalsChoice | null;
  onChoice: (choice: TotalsChoice) => void;
  // Offer the "all OK" affirmation only when the untouched scan already
  // matched (see NineReview.pristineMatch / roundPristine) — never after the
  // user edited a score into agreement, where "I corrected a score" is right.
  canAffirm: boolean;
}) {
  const checked = rows.filter((row) => row.written !== null);
  if (checked.length === 0) {
    return <p className="text-sm text-muted-foreground">No handwritten totals to check.</p>;
  }

  const allMatch = checked.every((row) => row.computed === row.written);
  // Totals that checked out at extraction (and still do) need no ruling —
  // just the per-player checkmarks. Anything else needs the user to say
  // whether the card is wrong or a score was corrected.
  const agreed = allMatch && choice === "agree";

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <p className="text-sm font-medium">
        {agreed ? "Written totals" : "Check the written totals"}
      </p>
      <div className="flex flex-col gap-1 text-sm">
        {checked.map((row) => {
          const matches = row.computed === row.written;
          return (
            <div key={row.label} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                <span className="text-muted-foreground">
                  scores sum to {row.computed ?? "–"} · written as {row.written}
                </span>
                {matches ? (
                  <Check aria-label="Totals match" className="size-4 text-primary" />
                ) : (
                  <X aria-label="Totals differ" className="size-4 text-destructive" />
                )}
              </span>
            </div>
          );
        })}
      </div>
      {!agreed && (
        <div className="flex flex-wrap gap-2">
          {(
            [
              // Only when the untouched scan already agreed: let the user affirm
              // it rather than forcing a "wrong"/"corrected" claim. Hidden once
              // any score is edited (canAffirm goes false).
              ...(canAffirm
                ? ([["agree", "Totals look right — all OK"]] as [TotalsChoice, string][])
                : []),
              ["wrong", "Written totals are wrong"],
              ["corrected", "I corrected a score — now it's right"],
            ] as [TotalsChoice, string][]
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={choice === value ? "default" : "outline"}
              onClick={() => onChoice(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReviewRound({
  extracted,
  matched,
  scorecardId,
  previewUrl,
  onRetake,
  onSubmitted,
}: {
  extracted: ExtractDataSchema;
  matched: MatchedData | null;
  scorecardId: string | null;
  previewUrl: string | null;
  onRetake: () => void;
  onSubmitted: (outingId: string) => void;
}) {
  const [step, setStep] = useState<"round" | "nines">("round");

  const [date, setDate] = useState(() => parseExtractedDate(extracted.date));
  const [courseId, setCourseId] = useState<string | null>(matched?.course.courseId ?? null);
  const [players, setPlayers] = useState<PlayerReview[]>(() =>
    distinctPlayers(extracted).map((entry) => ({
      ...entry,
      playerId: matched?.players.find((player) => player.name === entry.name)?.userId ?? null,
      ignored: false,
    })),
  );
  const [nines, setNines] = useState<NineReview[]>(() =>
    extracted.nines.map((nine, index) => {
      const writtenTotals = nine.players.map((_, pi) => nine.writtenTotals[pi] ?? null);
      const computed = nine.players.map((_, pi) =>
        sumOrNull(nine.holes.map((hole) => hole.scores[pi] ?? null)),
      );
      return {
        nineName: nine.nineName,
        playerNames: nine.players.map((player) => player.name),
        holes: nine.holes.map((hole) => ({ number: hole.hole, par: hole.par })),
        scores: nine.holes.map((hole) => nine.players.map((_, pi) => hole.scores[pi] ?? null)),
        writtenTotals,
        courseSetId: matched?.course.sets[index]?.courseSetId ?? null,
        teeIds: nine.players.map(() => null),
        totalsChoice: writtenTotalsMatch(writtenTotals, computed) ? ("agree" as const) : null,
        pristineMatch: writtenTotalsMatch(writtenTotals, computed),
      };
    }),
  );
  // Whether the 18-hole totals checked out against the untouched scan — the
  // gate for offering "all OK" on the round; any score edit clears it.
  const [roundPristine, setRoundPristine] = useState(() => {
    const names = distinctPlayers(extracted).map((entry) => entry.name);
    const written = names.map((_, index) => extracted.writtenTotals[index] ?? null);
    const computed = names.map((name) =>
      sumOrNull(
        extracted.nines.flatMap((nine) =>
          nine.players.flatMap((player, pi) =>
            player.name === name ? nine.holes.map((hole) => hole.scores[pi] ?? null) : [],
          ),
        ),
      ),
    );
    return writtenTotalsMatch(written, computed);
  });
  const [roundChoice, setRoundChoice] = useState<TotalsChoice | null>(() => {
    // Mirror roundRows below: the 18-hole written totals are index-aligned
    // with the distinct player list, computed sums that player's extracted
    // cells across every nine.
    const names = distinctPlayers(extracted).map((entry) => entry.name);
    const written = names.map((_, index) => extracted.writtenTotals[index] ?? null);
    const computed = names.map((name) =>
      sumOrNull(
        extracted.nines.flatMap((nine) =>
          nine.players.flatMap((player, pi) =>
            player.name === name ? nine.holes.map((hole) => hole.scores[pi] ?? null) : [],
          ),
        ),
      ),
    );
    return writtenTotalsMatch(written, computed) ? "agree" : null;
  });

  const [mergeAccepted, setMergeAccepted] = useState(false);
  // A payload we couldn't even assemble (an unmatched golfer, a missing tee) —
  // separate from the POST's own failure below.
  const [payloadError, setPayloadError] = useState<string | null>(null);

  // Both registries are paginated; these pickers filter client-side, so they
  // want the whole (name-sorted) list. Courses load on mount (the matched course
  // needs a name to display) and refetch when the combobox opens, so a course
  // added in another tab shows up without a reload.
  const coursesQuery = useQuery(allCoursesQuery());
  const courses: CourseWithSets[] = coursesQuery.data ?? NO_RECORDS;
  const coursesLoaded = coursesQuery.isSuccess;
  const golfers: Golfer[] = useQuery(allGolfersQuery()).data ?? NO_RECORDS;

  // Ask the API whether an outing already exists on this date with any of the
  // selected course sets — the two-scorecards-one-foursome case. Nines whose
  // players are all ignored won't be submitted, so they don't participate.
  const selectedSetIdsKey = nines
    .filter((nine) => nine.playerNames.some((name) => !nameIgnored(name)))
    .map((nine) => nine.courseSetId)
    .filter((id): id is string => id !== null)
    .sort()
    .join(",");
  const checkQuery = useQuery({
    ...apiQuery(api.outings.check.$get, {
      query: { date, courseSetIds: selectedSetIdsKey },
    }),
    // Only worth asking once the user is on the per-nine step with a real date
    // and at least one nine chosen.
    enabled: selectedSetIdsKey !== "" && DATE_PATTERN.test(date) && step === "nines",
  });
  const mergeCandidate: OutingDetail | null = checkQuery.data?.outing ?? null;

  // Scores already in the merge candidate that this capture would replace
  // (submit upserts on outing+player+hole), summarized per golfer as
  // "Blue 1–9"-style ranges so the user knows what "add to outing" costs.
  const overwriteWarnings = useMemo(() => {
    if (!mergeCandidate) return [];
    const byPlayer = new Map<string, { name: string; labels: string[] }>();
    for (const nine of nines) {
      const targetSet = mergeCandidate.sets.find((set) => set.id === nine.courseSetId);
      if (!targetSet) continue;
      nine.playerNames.forEach((writtenName, playerIndex) => {
        const review = players.find((entry) => entry.name === writtenName);
        if (!review?.playerId) return;
        const existing = targetSet.scores[review.playerId];
        if (!existing) return;
        const numbers = nine.holes
          .filter(
            (hole, holeIndex) =>
              (nine.scores[holeIndex]?.[playerIndex] ?? null) !== null &&
              existing[hole.number] !== undefined,
          )
          .map((hole) => hole.number)
          .sort((a, b) => a - b);
        if (numbers.length === 0) return;
        const contiguous = numbers.every(
          (number, index) => index === 0 || number === numbers[index - 1] + 1,
        );
        const range =
          numbers.length === 1
            ? `${numbers[0]}`
            : contiguous
              ? `${numbers[0]}–${numbers[numbers.length - 1]}`
              : numbers.join(", ");
        const golfer = golfers.find((entry) => entry.id === review.playerId);
        const entry = byPlayer.get(review.playerId) ?? {
          name: golfer?.name ?? golfer?.email ?? writtenName,
          labels: [],
        };
        entry.labels.push(`${targetSet.name} ${range}`);
        byPlayer.set(review.playerId, entry);
      });
    }
    return [...byPlayer.values()].map((entry) => `${entry.name}: ${entry.labels.join(", ")}`);
  }, [mergeCandidate, nines, players, golfers]);

  const mergeTarget = mergeAccepted ? mergeCandidate : null;
  const merging = mergeTarget !== null;
  const effectiveCourseId = mergeTarget ? mergeTarget.course.id : courseId;
  const selectedCourse = courses.find((course) => course.id === effectiveCourseId) ?? null;

  // Fill in default tees wherever a nine has a set but a player has no tee
  // yet (or holds one from a previously selected set). Runs whenever the
  // inputs to the default change; manual picks that are still valid for the
  // set are never overwritten, and the no-op case returns the same state
  // object so this can't loop.
  useEffect(() => {
    if (!selectedCourse) return;
    setNines((current) => {
      let anyChanged = false;
      const next = current.map((nine) => {
        const set = selectedCourse.sets.find((entry) => entry.id === nine.courseSetId);
        if (!set) return nine;
        const mergeSet = mergeTarget?.sets.find((entry) => entry.id === nine.courseSetId);
        let nineChanged = false;
        const teeIds = nine.playerNames.map((name, playerIndex) => {
          const currentTee = nine.teeIds[playerIndex] ?? null;
          if (currentTee !== null && set.tees.some((tee) => tee.id === currentTee)) {
            return currentTee;
          }
          const review = players.find((entry) => entry.name === name);
          const golfer = golfers.find((entry) => entry.id === review?.playerId);
          const fallback = defaultTeeFor(set, golfer, mergeSet)?.id ?? null;
          if (fallback !== currentTee) nineChanged = true;
          return fallback;
        });
        if (!nineChanged) return nine;
        anyChanged = true;
        return { ...nine, teeIds };
      });
      return anyChanged ? next : current;
    });
  }, [selectedCourse, golfers, players, mergeTarget, nines]);

  function updatePlayer(index: number, update: Partial<PlayerReview>) {
    setPlayers((current) =>
      current.map((player, i) => (i === index ? { ...player, ...update } : player)),
    );
  }

  // `value` is a golfer id, null (cleared), or the IGNORE_PLAYER sentinel —
  // ignoring drops the written name from the round entirely.
  function assignGolfer(index: number, value: string | null) {
    const writtenName = players[index]?.name;
    const ignored = value === IGNORE_PLAYER;
    updatePlayer(index, { playerId: ignored ? null : value, ignored });
    // Clear the player's per-nine tees so the defaulting effect re-derives
    // them from the newly assigned golfer's preference.
    setNines((current) =>
      current.map((nine) => ({
        ...nine,
        teeIds: nine.teeIds.map((teeId, playerIndex) =>
          nine.playerNames[playerIndex] === writtenName ? null : teeId,
        ),
      })),
    );
  }

  function updateNine(index: number, update: Partial<NineReview>) {
    setNines((current) => current.map((nine, i) => (i === index ? { ...nine, ...update } : nine)));
  }

  function setScore(nineIndex: number, holeIndex: number, playerIndex: number, raw: string) {
    const value = raw.trim() === "" ? null : Number.parseInt(raw, 10);
    if (value !== null && (Number.isNaN(value) || value < 1)) return;
    setNines((current) =>
      current.map((nine, i) => {
        if (i !== nineIndex) return nine;
        const scores = nine.scores.map((row, hi) =>
          hi === holeIndex ? row.map((cell, pi) => (pi === playerIndex ? value : cell)) : row,
        );
        // Any edit means this nine (and the 18-hole total) is no longer the
        // untouched scan, so "all OK" is no longer offered for it.
        return { ...nine, scores, pristineMatch: false };
      }),
    );
    setRoundPristine(false);
  }

  // Changing the course re-derives each nine's set: an exact par-sequence
  // match against any of a set's tee layouts wins, then a case-insensitive
  // name match, else unassigned. Tees reset so the defaults re-derive.
  function changeCourse(nextCourseId: string | null) {
    setCourseId(nextCourseId);
    const nextCourse = courses.find((course) => course.id === nextCourseId);
    setNines((current) =>
      current.map((nine) => {
        const signature = parSignature(nine.holes);
        const byPars = nextCourse?.sets.filter((set) =>
          set.tees.some((tee) => parSignature(tee.holes) === signature),
        );
        const byName = nextCourse?.sets.find(
          (set) => set.name.toLowerCase() === (nine.nineName ?? "").toLowerCase(),
        );
        const next = byPars?.length === 1 ? byPars[0] : byName;
        return {
          ...nine,
          courseSetId: next?.id ?? null,
          teeIds: nine.playerNames.map(() => null),
        };
      }),
    );
  }

  // Whether the review for a written name is set to be left off the round.
  function nameIgnored(writtenName: string): boolean {
    return players.find((entry) => entry.name === writtenName)?.ignored ?? false;
  }

  // The nines step shows who each golfer IS (their profile name), not the
  // scrawl on the card; names that aren't matched yet fall back to the scrawl.
  function golferLabel(writtenName: string): string {
    const review = players.find((entry) => entry.name === writtenName);
    const golfer = golfers.find((entry) => entry.id === review?.playerId);
    return golfer?.name ?? golfer?.email ?? writtenName;
  }

  function nineComputedTotals(nine: NineReview): (number | null)[] {
    return nine.playerNames.map((_, playerIndex) =>
      sumOrNull(nine.scores.map((row) => row[playerIndex] ?? null)),
    );
  }

  function nineTotalsRows(nine: NineReview): TotalsRow[] {
    const computed = nineComputedTotals(nine);
    return nine.playerNames
      .map((name, playerIndex) => ({ name, playerIndex }))
      .filter(({ name }) => !nameIgnored(name))
      .map(({ name, playerIndex }) => ({
        label: golferLabel(name),
        written: nine.writtenTotals[playerIndex] ?? null,
        computed: computed[playerIndex] ?? null,
      }));
  }

  // The card's 18-hole totals are index-aligned with the distinct player
  // list; the computed side sums the ASSIGNED GOLFER's cells across every
  // nine, so a card that writes one person under two names ("AJM"/"AJ")
  // still sums their whole round once both names point at the same golfer.
  // Ignored names have no row — nothing of theirs is being recorded.
  const roundRows: TotalsRow[] = players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => !player.ignored)
    .map(({ player, index }) => ({
      label: golferLabel(player.name),
      written: extracted.writtenTotals[index] ?? null,
      computed: sumOrNull(
        nines.flatMap((nine) =>
          nine.playerNames.flatMap((name, playerIndex) => {
            const sameGolfer =
              player.playerId !== null
                ? players.find((entry) => entry.name === name)?.playerId === player.playerId
                : name === player.name;
            return sameGolfer ? nine.scores.map((row) => row[playerIndex] ?? null) : [];
          }),
        ),
      ),
    }));
  const roundNeedsCheck = roundRows.some((row) => row.written !== null);

  // The nines step's round leaderboard, mirroring the outing page's golfers
  // table: one row per distinct golfer (ignored names excluded), strokes
  // summed across every nine that will be recorded. The best complete round
  // wins the trophy (ties share); a golfer who missed holes is marked
  // incomplete and never wins — their total isn't comparable.
  const leaderboard = (() => {
    const recorded = nines.filter((nine) => nine.playerNames.some((name) => !nameIgnored(name)));
    const totalHoles = recorded.reduce((count, nine) => count + nine.holes.length, 0);
    const byGolfer = new Map<string, { label: string; writtenNames: string[]; cells: number[] }>();
    for (const nine of recorded) {
      nine.playerNames.forEach((name, playerIndex) => {
        if (nameIgnored(name)) return;
        const playerId = players.find((entry) => entry.name === name)?.playerId;
        const key = playerId ?? `written:${name}`;
        const entry = byGolfer.get(key) ?? {
          label: golferLabel(name),
          writtenNames: [],
          cells: [],
        };
        if (!entry.writtenNames.includes(name)) entry.writtenNames.push(name);
        for (const row of nine.scores) {
          const cell = row[playerIndex] ?? null;
          if (cell !== null) entry.cells.push(cell);
        }
        byGolfer.set(key, entry);
      });
    }
    const totals = [...byGolfer.entries()].map(([key, entry]) => ({
      key,
      label: entry.label,
      writtenNames: entry.writtenNames,
      total: entry.cells.length > 0 ? entry.cells.reduce((sum, value) => sum + value, 0) : null,
      incomplete: entry.cells.length > 0 && entry.cells.length < totalHoles,
    }));
    const ranked = [...totals].sort((a, b) => {
      if ((a.total === null) !== (b.total === null)) return a.total === null ? 1 : -1;
      if (a.total === null || b.total === null) return 0;
      if (a.incomplete !== b.incomplete) return a.incomplete ? 1 : -1;
      return a.total - b.total;
    });
    // The winning total among complete rounds; null = nobody can win yet.
    const best = totals.reduce<number | null>(
      (min, entry) =>
        entry.total !== null && !entry.incomplete && (min === null || entry.total < min)
          ? entry.total
          : min,
      null,
    );
    return { totalHoles, ranked, best, anyIncomplete: totals.some((entry) => entry.incomplete) };
  })();

  const dateIsFuture = DATE_PATTERN.test(date) && date > localIsoDate(new Date());

  const roundProblems = useMemo(() => {
    const list: string[] = [];
    if (!DATE_PATTERN.test(date)) list.push("Pick a date for the round.");
    if (dateIsFuture) {
      list.push("The date is in the future — rounds can't be post-dated. Use the Today button.");
    }
    if (courseId === null) list.push("Pick the course — nines can only come from a known course.");
    const unassigned = players.filter((player) => player.playerId === null && !player.ignored);
    if (unassigned.length > 0) {
      list.push(
        `Match ${unassigned.map((player) => `“${player.name}”`).join(", ")} to golfers — invite ` +
          "anyone missing from the Golfers tab first, or ignore names that shouldn't be recorded.",
      );
    }
    if (players.length > 0 && players.every((player) => player.ignored)) {
      list.push("Every golfer is ignored — match at least one to record the round.");
    }
    // Two written names MAY point at one golfer (the card wrote "AJM" on one
    // nine and "AJ" on the other) — but within a single nine, two score
    // columns can't belong to the same person.
    for (const nine of nines) {
      const ids = nine.playerNames
        .map((name) => players.find((entry) => entry.name === name)?.playerId)
        .filter((id): id is string => id !== null && id !== undefined);
      if (new Set(ids).size !== ids.length) {
        list.push(
          `On “${defaultNineName(nine)}”, two written names are assigned to the same golfer — ` +
            "one nine can't have two score columns for one person.",
        );
      }
    }
    if (nines.length === 0) list.push("No holes were extracted — retake the photo.");
    return list;
  }, [date, dateIsFuture, courseId, players, nines]);

  // Recomputed every render — it's a handful of comparisons, and it depends
  // on derived rows (roundRows) that change identity each render anyway.
  const nineProblems = (() => {
    const list: string[] = [];
    nines.forEach((nine, index) => {
      // A nine whose written names are all ignored is dropped at submit, so
      // nothing about it needs to check out.
      if (nine.playerNames.every((name) => nameIgnored(name))) return;
      const title = defaultNineName(nine);
      if (nine.courseSetId === null) {
        list.push(`Pick which nine “${title}” is.`);
        return;
      }
      const set = selectedCourse?.sets.find((entry) => entry.id === nine.courseSetId);
      if (!set) return;
      if (set.tees.length === 0) {
        list.push(`“${title}”: ${set.name} has no tees recorded — pick a different nine.`);
        return;
      }
      nine.playerNames.forEach((name, playerIndex) => {
        if (nameIgnored(name)) return;
        const tee = set.tees.find((entry) => entry.id === nine.teeIds[playerIndex]);
        if (!tee) {
          list.push(`Pick which tee ${golferLabel(name)} played “${title}” from.`);
          return;
        }
        const teeNumbers = new Set(tee.holes.map((hole) => hole.number));
        const missing = nine.holes.filter((hole) => !teeNumbers.has(hole.number));
        if (missing.length > 0) {
          list.push(
            `“${title}”: the ${teeLabel(tee)} tees of ${set.name} have no hole ` +
              `${missing.map((hole) => hole.number).join(", ")} — pick a different nine or tee.`,
          );
        }
      });
      if (
        nines.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.courseSetId === nine.courseSetId &&
            other.playerNames.some((name) => !nameIgnored(name)),
        )
      ) {
        list.push(`Two nines are assigned to ${set.name} — each nine needs its own.`);
      }
      const problem = totalsProblem(`“${title}”`, nineTotalsRows(nine), nine.totalsChoice);
      if (problem) list.push(problem);
    });
    if (roundNeedsCheck) {
      const problem = totalsProblem("the round totals", roundRows, roundChoice);
      if (problem) list.push(problem);
    }
    return [...new Set(list)];
  })();

  const submitMutation = useMutation({
    ...apiMutation(api.outings.$post),
    onSuccess: ({ outingId }) => onSubmitted(outingId),
  });
  const submitting = submitMutation.isPending;
  const submitError = payloadError ?? submitMutation.error?.message ?? null;

  function submit() {
    if (roundProblems.length > 0 || nineProblems.length > 0) return;
    setPayloadError(null);
    let payload: SubmitOutingRequestSchema;
    try {
      payload = {
        date,
        scorecardId,
        outingId: mergeTarget?.id ?? null,
        courseId: mergeTarget ? null : courseId,
        nines: nines.flatMap((nine) => {
          // Ignored names are left out; a nine with nobody left is dropped
          // entirely (the API requires at least one player per nine).
          const active = nine.playerNames
            .map((name, playerIndex) => ({ name, playerIndex }))
            .filter(({ name }) => !nameIgnored(name));
          if (active.length === 0) return [];
          if (nine.courseSetId === null) {
            throw new Error(`“${defaultNineName(nine)}” has no nine selected.`);
          }
          return [
            {
              courseSetId: nine.courseSetId,
              players: active.map(({ name, playerIndex }) => {
                const player = players.find((entry) => entry.name === name);
                if (!player?.playerId) throw new Error(`“${name}” is not matched to a golfer.`);
                const teeId = nine.teeIds[playerIndex] ?? null;
                if (teeId === null) throw new Error(`“${name}” has no tee selected.`);
                return {
                  playerId: player.playerId,
                  courseSetTeeId: teeId,
                  scores: nine.holes.map((hole, holeIndex) => ({
                    holeNumber: hole.number,
                    score: nine.scores[holeIndex]?.[playerIndex] ?? null,
                  })),
                };
              }),
            },
          ];
        }),
      };
    } catch (error) {
      setPayloadError(error instanceof Error ? error.message : "Unable to save this round.");
      return;
    }
    submitMutation.mutate({ json: payload });
  }

  if (step === "round") {
    return (
      <div className="flex flex-col gap-5">
        {previewUrl && (
          <ImageExpand
            src={previewUrl}
            alt="Captured scorecard"
            className="max-h-56 w-full rounded-2xl border bg-muted object-contain"
          />
        )}

        <ReviewSection title="Round" description="When and where this scorecard was played.">
          <div className="flex flex-col gap-2">
            <Label htmlFor="round-date">
              <CalendarDays aria-hidden="true" className="mr-1 inline size-4" />
              Date
            </Label>
            <div className="flex gap-2">
              <Input
                id="round-date"
                type="date"
                // iOS gives date inputs UA styling: extra intrinsic height and
                // a centered value. Strip it and pin the value left so the
                // field lines up with the selects around it.
                className="h-9 flex-1 appearance-none justify-start text-left [&::-webkit-date-and-time-value]:m-0 [&::-webkit-date-and-time-value]:text-left"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                aria-invalid={dateIsFuture}
              />
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0"
                onClick={() => setDate(localIsoDate(new Date()))}
              >
                Today
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="round-course">Course</Label>
            <ResponsiveSelect
              id="round-course"
              value={courseId}
              onValueChange={(value) => changeCourse(value)}
              options={
                coursesLoaded
                  ? courses.map((course) => ({
                      value: course.id,
                      label: course.name,
                      description: course.location ?? undefined,
                    }))
                  : null
              }
              onOpen={() => void coursesQuery.refetch()}
              placeholder="— Choose course —"
              title="Choose course"
              searchPlaceholder="Search courses…"
              emptyMessage="No courses match."
              invalid={courseId === null}
            />
          </div>
        </ReviewSection>

        <ReviewSection
          title="Golfers"
          description="Match each name written on the card to a golfer — or ignore a name to leave it off the round. Tees are picked per nine in the next step."
        >
          <div className="flex flex-col divide-y">
            {players.map((player, index) => {
              const aliases = players
                .filter(
                  (other, otherIndex) =>
                    otherIndex !== index &&
                    other.playerId !== null &&
                    other.playerId === player.playerId,
                )
                .map((other) => `“${other.name}”`);
              return (
                <div key={player.name} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3">
                    {(() => {
                      const withBox = player.occurrences.find((occurrence) => occurrence.bbox);
                      return previewUrl && withBox?.bbox ? (
                        <InitialsThumbnail src={previewUrl} bbox={withBox.bbox} />
                      ) : null;
                    })()}
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="text-sm">
                        Written on card: <span className="font-medium">“{player.name}”</span>
                      </p>
                      {player.occurrences.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {player.occurrences.map((occurrence) => occurrence.location).join(" · ")}
                        </p>
                      )}
                    </div>
                  </div>
                  {player.guesses.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Could also read: {player.guesses.map((guess) => `“${guess}”`).join(", ")}
                    </p>
                  )}
                  {aliases.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Same golfer as {aliases.join(" and ")} — their nines are scored as one player.
                    </p>
                  )}
                  <ResponsiveSelect
                    ariaLabel={`Golfer for ${player.name}`}
                    value={player.ignored ? IGNORE_PLAYER : player.playerId}
                    onValueChange={(value) => assignGolfer(index, value)}
                    options={[
                      {
                        value: IGNORE_PLAYER,
                        label: "Ignore this golfer",
                        description: "Leave this name off the round — nothing is recorded for it.",
                      },
                      ...golfers.map((golfer) => ({
                        value: golfer.id,
                        label: golfer.name ?? golfer.email ?? "Unnamed golfer",
                      })),
                    ]}
                    // The trigger shows the ignored state as a fact, not the
                    // list row's imperative "Ignore this golfer".
                    renderValue={(option) =>
                      option?.value === IGNORE_PLAYER ? (
                        <span className="text-muted-foreground">Ignored — not recorded</span>
                      ) : (
                        (option?.label ?? "— Choose golfer —")
                      )
                    }
                    searchable
                    clearable
                    invalid={player.playerId === null && !player.ignored}
                    placeholder="— Choose golfer —"
                    title={`Golfer for “${player.name}”`}
                    searchPlaceholder="Search golfers…"
                  />
                </div>
              );
            })}
          </div>
        </ReviewSection>

        <StickyActions>
          {roundProblems.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-destructive">
              {roundProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap justify-between gap-3">
            <Button variant="outline" onClick={onRetake}>
              <RefreshCcw data-icon="inline-start" />
              Retake
            </Button>
            <Button onClick={() => setStep("nines")} disabled={roundProblems.length > 0}>
              Review nines
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        </StickyActions>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {nines.map((nine, nineIndex) => {
        // Only the non-ignored written names get columns, tee pickers, and
        // totals rows; playerIndex stays the ORIGINAL index into the nine's
        // index-aligned arrays (scores, teeIds, writtenTotals).
        const activePlayers = nine.playerNames
          .map((name, playerIndex) => ({ name, playerIndex }))
          .filter(({ name }) => !nameIgnored(name));
        if (activePlayers.length === 0) {
          return (
            <ReviewSection key={nineIndex} title={defaultNineName(nine)}>
              <p className="text-sm text-muted-foreground">
                Every golfer on this nine is ignored — it won't be recorded.
              </p>
            </ReviewSection>
          );
        }
        const set = selectedCourse?.sets.find((entry) => entry.id === nine.courseSetId);
        // Par per tee, for the database-par column and the score notation:
        // the column shows the first player's tee (pars rarely differ), each
        // score cell judges against the tee its player actually hit from.
        const parByTee = new Map(
          (set?.tees ?? []).map((tee) => [
            tee.id,
            new Map(tee.holes.map((hole) => [hole.number, hole.par])),
          ]),
        );
        const playerPars = (playerIndex: number) =>
          parByTee.get(nine.teeIds[playerIndex] ?? "") ?? null;
        const displayPars =
          playerPars(activePlayers[0].playerIndex) ?? [...parByTee.values()][0] ?? null;
        const computedTotals = nineComputedTotals(nine);
        return (
          <ReviewSection
            key={nineIndex}
            title={defaultNineName(nine)}
            description="Confirm which nine this is and each golfer's tee, fix any misread scores, then check the totals."
          >
            <div className="flex flex-col gap-2">
              <Label>Nine at {selectedCourse?.name ?? "the course"}</Label>
              <ResponsiveSelect
                ariaLabel={`Course nine for ${defaultNineName(nine)}`}
                value={nine.courseSetId}
                onValueChange={(value) =>
                  updateNine(nineIndex, {
                    courseSetId: value,
                    // Reset tees so the defaults re-derive for the new set.
                    teeIds: nine.playerNames.map(() => null),
                  })
                }
                options={(selectedCourse?.sets ?? []).map((entry) => ({
                  value: entry.id,
                  label: entry.name,
                }))}
                clearable
                invalid={nine.courseSetId === null}
                placeholder="— Choose nine —"
                title={`Nine at ${selectedCourse?.name ?? "the course"}`}
                // Custom row: append the nine's hole range (muted) after its
                // name, while the trigger stays just the name.
                renderItem={(option) => {
                  const entry = selectedCourse?.sets.find((s) => s.id === option.value);
                  const numbers =
                    entry?.tees.flatMap((tee) => tee.holes.map((hole) => hole.number)) ?? [];
                  const range =
                    numbers.length > 0
                      ? ` · holes ${Math.min(...numbers)}–${Math.max(...numbers)}`
                      : "";
                  return (
                    <span className="truncate">
                      {option.label}
                      {range && <span className="text-muted-foreground">{range}</span>}
                    </span>
                  );
                }}
              />
            </div>

            {set && set.tees.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {activePlayers.map(({ name, playerIndex }) => (
                  <div key={name} className="flex flex-col gap-2">
                    <Label>Tee for {golferLabel(name)}</Label>
                    <ResponsiveSelect
                      ariaLabel={`Tee for ${golferLabel(name)} on ${defaultNineName(nine)}`}
                      value={nine.teeIds[playerIndex] ?? null}
                      onValueChange={(value) =>
                        updateNine(nineIndex, {
                          teeIds: nine.teeIds.map((teeId, index) =>
                            index === playerIndex ? value : teeId,
                          ),
                        })
                      }
                      options={sortTees(set.tees).map((tee) => ({
                        value: tee.id,
                        label: teeLabel(tee),
                      }))}
                      clearable
                      invalid={nine.teeIds[playerIndex] === null}
                      placeholder="— Choose tee —"
                      title={`Tee for ${golferLabel(name)}`}
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-2 pl-0 font-medium">Hole</th>
                    <th className="p-2 font-medium">Par</th>
                    {activePlayers.map(({ name }) => (
                      <th key={name} className="p-2 text-center font-medium">
                        {golferLabel(name)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {nine.holes.map((hole, holeIndex) => (
                    <tr key={hole.number} className="border-b">
                      <td className="p-2 pl-0 font-medium">{hole.number}</td>
                      <td className="p-2 text-muted-foreground">
                        {displayPars?.get(hole.number) ?? hole.par}
                      </td>
                      {activePlayers.map(({ name, playerIndex }) => (
                        <td key={name} className="p-2 text-center">
                          <GolfScore
                            aria-label={`${golferLabel(name)}'s score on hole ${hole.number}`}
                            score={nine.scores[holeIndex]?.[playerIndex] ?? null}
                            par={playerPars(playerIndex)?.get(hole.number) ?? hole.par}
                            onChange={(raw) => setScore(nineIndex, holeIndex, playerIndex, raw)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="p-2 pl-0 font-medium">Total</td>
                    <td className="p-2" />
                    {activePlayers.map(({ name, playerIndex }) => (
                      <td key={name} className="p-2 text-center font-medium">
                        <Score value={computedTotals[playerIndex] ?? null} />
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>

            <TotalsCheck
              rows={nineTotalsRows(nine)}
              choice={nine.totalsChoice}
              onChoice={(choice) => updateNine(nineIndex, { totalsChoice: choice })}
              canAffirm={nine.pristineMatch}
            />
          </ReviewSection>
        );
      })}

      <ReviewSection
        title="Round totals"
        description="Every golfer's strokes across the whole card, from the scores above."
      >
        <div className="flex flex-col divide-y">
          {leaderboard.ranked.map((entry) => {
            const winner =
              entry.total !== null && !entry.incomplete && entry.total === leaderboard.best;
            return (
              <div
                key={entry.key}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                {leaderboard.best !== null && (
                  <span aria-hidden={!winner} className="flex w-7 shrink-0 items-center">
                    {winner && (
                      <Trophy
                        aria-label="First place"
                        className="size-5 text-amber-600 dark:text-amber-400"
                      />
                    )}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{entry.label}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    Written as {entry.writtenNames.map((name) => `“${name}”`).join(" · ")}
                  </span>
                </span>
                <Score
                  value={entry.total}
                  incomplete={entry.incomplete}
                  className="shrink-0 text-lg font-semibold"
                />
              </div>
            );
          })}
        </div>
        {leaderboard.anyIncomplete && (
          <p className="text-xs text-muted-foreground">
            <sup>+</sup> didn't play all {leaderboard.totalHoles} holes on this card — the total
            only counts holes with a recorded score.
          </p>
        )}
        {roundNeedsCheck && (
          <TotalsCheck
            rows={roundRows}
            choice={roundChoice}
            onChoice={setRoundChoice}
            canAffirm={roundPristine}
          />
        )}
      </ReviewSection>

      {mergeCandidate && (
        <ReviewSection
          title={
            <span className="flex items-center gap-2">
              <GitMerge aria-hidden="true" className="size-4" />
              Add to an existing outing?
            </span>
          }
          description={
            <>
              There's already an outing at {mergeCandidate.course.name} on{" "}
              {formatOutingDate(mergeCandidate.date)} on the same nine
              {mergeCandidate.sets.length === 1 ? "" : "s"} — this happens when one group splits
              across two scorecards.
            </>
          }
        >
          <div className="flex flex-col gap-2">
            {mergeCandidate.sets.map((set) => (
              <div key={set.id} className="text-sm">
                <span className="font-medium">{set.name}:</span>{" "}
                <span className="text-muted-foreground">
                  {mergeCandidate.players
                    .filter((player) => set.scores[player.id])
                    .map((player) => {
                      const cells = Object.values(set.scores[player.id] ?? {});
                      const total = cells.reduce((sum, value) => sum + value, 0);
                      return `${playerLabel(player)} (${total})`;
                    })
                    .join(", ") || "no scores yet"}
                </span>
              </div>
            ))}
            {overwriteWarnings.length > 0 && (
              <div className="mt-1 flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium text-destructive">
                  <TriangleAlert aria-hidden="true" className="size-4" />
                  Adding to this outing will overwrite existing scores
                </p>
                <ul className="flex flex-col gap-0.5 text-muted-foreground">
                  {overwriteWarnings.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="flex gap-3">
            <Button
              variant={mergeAccepted ? "default" : "outline"}
              onClick={() => setMergeAccepted(true)}
            >
              Add to that outing
            </Button>
            <Button
              variant={mergeAccepted ? "outline" : "default"}
              onClick={() => setMergeAccepted(false)}
            >
              Keep separate
            </Button>
          </div>
        </ReviewSection>
      )}

      <StickyActions>
        {nineProblems.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-destructive">
            {nineProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {submitError && <p className="text-sm text-destructive">{submitError}</p>}
        <div className="flex flex-wrap justify-between gap-3">
          <Button variant="outline" onClick={() => setStep("round")}>
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || roundProblems.length > 0 || nineProblems.length > 0}
          >
            <Send data-icon="inline-start" />
            {submitting ? "Saving…" : merging ? "Add to outing" : "Submit round"}
          </Button>
        </div>
      </StickyActions>
    </div>
  );
}
