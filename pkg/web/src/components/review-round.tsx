import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  GitMerge,
  RefreshCcw,
  Send,
  X,
} from "lucide-react";
import type { ExtractDataSchema, MatchedData, SubmitOutingRequestSchema, Tee } from "api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import type { Golfer } from "@/pages/golfers";
import { formatOutingDate, playerLabel, type OutingDetail } from "@/pages/outings";
import { TEE_LABELS, TEES } from "@/lib/tees";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type CourseWithSets = {
  id: string;
  name: string;
  location: string | null;
  sets: {
    id: string;
    name: string;
    disposition: "front" | "back" | null;
    courseId: string;
    holes: { id: string; number: number; name: string | null; par: number }[];
  }[];
};

type PlayerReview = { name: string; playerId: string | null; tee: Tee | null };

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
  totalsChoice: TotalsChoice | null;
};

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

type TotalsRow = { label: string; written: number | null; computed: number | null };

// null = section fine (or nothing handwritten to check); otherwise the
// problem message blocking submit.
function totalsProblem(section: string, rows: TotalsRow[], choice: TotalsChoice | null) {
  const checked = rows.filter((row) => row.written !== null);
  if (checked.length === 0) return null;
  const matches = checked.every((row) => row.computed === row.written);
  if (choice === null) return `Confirm the written totals for ${section}.`;
  if (choice !== "wrong" && !matches) {
    return (
      `${section}: the written totals still don't match the summed scores — ` +
      "fix a score or mark the written totals as wrong."
    );
  }
  if (choice === "wrong" && matches) {
    return `${section}: the totals now match — mark them as agreeing instead.`;
  }
  return null;
}

function TotalsCheck({
  rows,
  choice,
  onChoice,
}: {
  rows: TotalsRow[];
  choice: TotalsChoice | null;
  onChoice: (choice: TotalsChoice) => void;
}) {
  const checked = rows.filter((row) => row.written !== null);
  if (checked.length === 0) {
    return <p className="text-sm text-muted-foreground">No handwritten totals to check.</p>;
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3">
      <p className="text-sm font-medium">Check the written totals</p>
      <div className="flex flex-col gap-1 text-sm">
        {checked.map((row) => {
          const matches = row.computed === row.written;
          return (
            <div key={row.label} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                <span className="text-muted-foreground">
                  written {row.written} · summed {row.computed ?? "–"}
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
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["agree", "Totals agree"],
            ["wrong", "Written totals are wrong"],
            ["corrected", "I corrected a score — now it's right"],
          ] as const
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
  const { client } = useAuth();
  const [golfers, setGolfers] = useState<Golfer[]>([]);
  const [courses, setCourses] = useState<CourseWithSets[]>([]);
  const [step, setStep] = useState<"round" | "nines">("round");

  const [date, setDate] = useState(() => parseExtractedDate(extracted.date));
  const [courseId, setCourseId] = useState<string | null>(matched?.course.courseId ?? null);
  const [players, setPlayers] = useState<PlayerReview[]>(() => {
    const names = [...new Set(extracted.nines.flatMap((nine) => nine.players))];
    return names.map((name) => ({
      name,
      playerId: matched?.players.find((player) => player.name === name)?.userId ?? null,
      tee: null,
    }));
  });
  const [nines, setNines] = useState<NineReview[]>(() =>
    extracted.nines.map((nine, index) => ({
      nineName: nine.nineName,
      playerNames: nine.players,
      holes: nine.holes.map((hole) => ({ number: hole.hole, par: hole.par })),
      scores: nine.holes.map((hole) => nine.players.map((_, pi) => hole.scores[pi] ?? null)),
      writtenTotals: nine.players.map((_, pi) => nine.writtenTotals[pi] ?? null),
      courseSetId: matched?.course.sets[index]?.courseSetId ?? null,
      totalsChoice: null,
    })),
  );
  const [roundChoice, setRoundChoice] = useState<TotalsChoice | null>(null);

  const [mergeCandidate, setMergeCandidate] = useState<OutingDetail | null>(null);
  const [mergeAccepted, setMergeAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    void client.api.golfers.$get().then(async (response) => {
      if (response.ok) setGolfers((await response.json()).golfers);
    });
    void client.api.courses.$get().then(async (response) => {
      if (response.ok) setCourses((await response.json()).courses);
    });
  }, [client]);

  // Once golfers load, default each matched player's tee to their preference.
  useEffect(() => {
    if (golfers.length === 0) return;
    setPlayers((current) =>
      current.map((player) => {
        if (player.tee !== null || player.playerId === null) return player;
        const golfer = golfers.find((entry) => entry.id === player.playerId);
        return golfer?.preferredTee ? { ...player, tee: golfer.preferredTee } : player;
      }),
    );
  }, [golfers]);

  const mergeTarget = mergeAccepted ? mergeCandidate : null;
  const merging = mergeTarget !== null;
  const effectiveCourseId = mergeTarget ? mergeTarget.course.id : courseId;
  const selectedCourse = courses.find((course) => course.id === effectiveCourseId) ?? null;

  // Ask the API whether an outing already exists on this date with any of the
  // selected course sets — the two-scorecards-one-foursome case.
  const selectedSetIdsKey = nines
    .map((nine) => nine.courseSetId)
    .filter((id): id is string => id !== null)
    .sort()
    .join(",");
  useEffect(() => {
    if (!client || selectedSetIdsKey === "" || !DATE_PATTERN.test(date) || step !== "nines") {
      setMergeCandidate(null);
      setMergeAccepted(false);
      return;
    }
    let cancelled = false;
    void client.api.outings.check
      .$get({ query: { date, courseSetIds: selectedSetIdsKey } })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const { outing } = await response.json();
        if (cancelled) return;
        setMergeCandidate(outing);
        if (!outing) setMergeAccepted(false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, date, selectedSetIdsKey, step]);

  function updatePlayer(index: number, update: Partial<PlayerReview>) {
    setPlayers((current) =>
      current.map((player, i) => (i === index ? { ...player, ...update } : player)),
    );
  }

  function assignGolfer(index: number, golferId: string | null) {
    const golfer = golfers.find((entry) => entry.id === golferId);
    updatePlayer(index, { playerId: golferId, tee: golfer?.preferredTee ?? null });
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
        return { ...nine, scores };
      }),
    );
  }

  // Changing the course re-derives each nine's set: an exact par-sequence
  // match wins, then a case-insensitive name match, else unassigned.
  function changeCourse(nextCourseId: string | null) {
    setCourseId(nextCourseId);
    const nextCourse = courses.find((course) => course.id === nextCourseId);
    setNines((current) =>
      current.map((nine) => {
        const signature = parSignature(nine.holes);
        const byPars = nextCourse?.sets.filter((set) => parSignature(set.holes) === signature);
        const byName = nextCourse?.sets.find(
          (set) => set.name.toLowerCase() === (nine.nineName ?? "").toLowerCase(),
        );
        const next = byPars?.length === 1 ? byPars[0] : byName;
        return { ...nine, courseSetId: next?.id ?? null };
      }),
    );
  }

  function nineComputedTotals(nine: NineReview): (number | null)[] {
    return nine.playerNames.map((_, playerIndex) =>
      sumOrNull(nine.scores.map((row) => row[playerIndex] ?? null)),
    );
  }

  function nineTotalsRows(nine: NineReview): TotalsRow[] {
    const computed = nineComputedTotals(nine);
    return nine.playerNames.map((name, playerIndex) => ({
      label: name,
      written: nine.writtenTotals[playerIndex] ?? null,
      computed: computed[playerIndex] ?? null,
    }));
  }

  // The card's 18-hole totals are index-aligned with the distinct player
  // list; the computed side sums that player's cells across every nine.
  const roundRows: TotalsRow[] = players.map((player, index) => ({
    label: player.name,
    written: extracted.writtenTotals[index] ?? null,
    computed: sumOrNull(
      nines.flatMap((nine) =>
        nine.playerNames.flatMap((name, playerIndex) =>
          name === player.name ? nine.scores.map((row) => row[playerIndex] ?? null) : [],
        ),
      ),
    ),
  }));
  const roundNeedsCheck = roundRows.some((row) => row.written !== null);

  const roundProblems = useMemo(() => {
    const list: string[] = [];
    if (!DATE_PATTERN.test(date)) list.push("Pick a date for the round.");
    if (courseId === null) list.push("Pick the course — nines can only come from a known course.");
    const unassigned = players.filter((player) => player.playerId === null);
    if (unassigned.length > 0) {
      list.push(
        `Match ${unassigned.map((player) => `“${player.name}”`).join(", ")} to golfers — invite ` +
          "anyone missing from the Golfers tab first.",
      );
    }
    const assigned = players.filter((player) => player.playerId !== null);
    if (new Set(assigned.map((player) => player.playerId)).size !== assigned.length) {
      list.push("Two written names point at the same golfer — fix the golfer assignments.");
    }
    if (nines.length === 0) list.push("No holes were extracted — retake the photo.");
    return list;
  }, [date, courseId, players, nines]);

  // Recomputed every render — it's a handful of comparisons, and it depends
  // on derived rows (roundRows) that change identity each render anyway.
  const nineProblems = (() => {
    const list: string[] = [];
    nines.forEach((nine, index) => {
      const title = defaultNineName(nine);
      if (nine.courseSetId === null) {
        list.push(`Pick which nine “${title}” is.`);
        return;
      }
      const set = selectedCourse?.sets.find((entry) => entry.id === nine.courseSetId);
      if (!set) return;
      const setNumbers = new Set(set.holes.map((hole) => hole.number));
      const missing = nine.holes.filter((hole) => !setNumbers.has(hole.number));
      if (missing.length > 0) {
        list.push(
          `“${title}”: ${set.name} has no hole ${missing.map((hole) => hole.number).join(", ")} — ` +
            "pick a different nine.",
        );
      }
      if (
        nines.some(
          (other, otherIndex) => otherIndex !== index && other.courseSetId === nine.courseSetId,
        )
      ) {
        list.push(`Two nines are assigned to ${set.name} — each nine needs its own.`);
      }
      const problem = totalsProblem(`“${title}”`, nineTotalsRows(nine), nine.totalsChoice);
      if (problem) list.push(problem);
    });
    if (roundNeedsCheck) {
      const problem = totalsProblem("the 18-hole totals", roundRows, roundChoice);
      if (problem) list.push(problem);
    }
    return [...new Set(list)];
  })();

  async function submit() {
    if (!client || roundProblems.length > 0 || nineProblems.length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload: SubmitOutingRequestSchema = {
        date,
        scorecardId,
        outingId: mergeTarget?.id ?? null,
        courseId: mergeTarget ? null : courseId,
        newCourse: null,
        nines: nines.map((nine) => ({
          courseSetId: nine.courseSetId,
          newSet: null,
          players: nine.playerNames.map((name, playerIndex) => {
            const player = players.find((entry) => entry.name === name);
            if (!player?.playerId) throw new Error(`“${name}” is not matched to a golfer.`);
            return {
              playerId: player.playerId,
              tee: player.tee,
              scores: nine.holes.map((hole, holeIndex) => ({
                holeNumber: hole.number,
                score: nine.scores[holeIndex]?.[playerIndex] ?? null,
              })),
            };
          }),
        })),
      };
      const response = await client.api.outings.$post({ json: payload });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Unable to save this round.");
      }
      const { outingId } = await response.json();
      onSubmitted(outingId);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to save this round.");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "round") {
    return (
      <div className="flex flex-col gap-5">
        {previewUrl && (
          <img
            src={previewUrl}
            alt="Captured scorecard"
            className="max-h-56 w-full rounded-2xl border bg-muted object-contain"
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle>Round</CardTitle>
            <CardDescription>When and where this scorecard was played.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="round-date">
                <CalendarDays aria-hidden="true" className="mr-1 inline size-4" />
                Date
              </Label>
              <Input
                id="round-date"
                type="date"
                // iOS gives date inputs UA styling: extra intrinsic height and
                // a centered value. Strip it and pin the value left so the
                // field lines up with the selects around it.
                className="h-9 appearance-none justify-start text-left [&::-webkit-date-and-time-value]:m-0 [&::-webkit-date-and-time-value]:text-left"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="round-course">Course</Label>
              <Select
                items={[
                  { value: null, label: "— Choose course —" },
                  ...courses.map((course) => ({ value: course.id, label: course.name })),
                ]}
                value={courseId}
                onValueChange={(value) => changeCourse(value as string | null)}
              >
                <SelectTrigger id="round-course" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={null}>— Choose course —</SelectItem>
                  {courses.map((course) => (
                    <SelectItem key={course.id} value={course.id}>
                      {course.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Golfers</CardTitle>
            <CardDescription>
              Match each name written on the card to a golfer and confirm their tee.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {players.map((player, index) => (
              <div key={player.name} className="flex flex-col gap-2 rounded-xl border p-3">
                <p className="text-sm">
                  Written on card: <span className="font-medium">“{player.name}”</span>
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select
                    items={[
                      { value: null, label: "— Choose golfer —" },
                      ...golfers.map((golfer) => ({
                        value: golfer.id,
                        label: golfer.name ?? golfer.email ?? "Unnamed golfer",
                      })),
                    ]}
                    value={player.playerId}
                    onValueChange={(value) => assignGolfer(index, value as string | null)}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={`Golfer for ${player.name}`}
                      aria-invalid={player.playerId === null}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={null}>— Choose golfer —</SelectItem>
                      {golfers.map((golfer) => (
                        <SelectItem key={golfer.id} value={golfer.id}>
                          {golfer.name ?? golfer.email ?? "Unnamed golfer"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    items={[
                      { value: null, label: "Tee not recorded" },
                      ...TEES.map((tee) => ({ value: tee, label: `${TEE_LABELS[tee]} tees` })),
                    ]}
                    value={player.tee}
                    onValueChange={(value) => updatePlayer(index, { tee: value as Tee | null })}
                  >
                    <SelectTrigger className="w-full" aria-label={`Tee for ${player.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={null}>Tee not recorded</SelectItem>
                      {TEES.map((tee) => (
                        <SelectItem key={tee} value={tee}>
                          {TEE_LABELS[tee]} tees
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3">
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
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {nines.map((nine, nineIndex) => {
        const set = selectedCourse?.sets.find((entry) => entry.id === nine.courseSetId);
        const setParByNumber = new Map(set?.holes.map((hole) => [hole.number, hole.par]) ?? []);
        const computedTotals = nineComputedTotals(nine);
        return (
          <Card key={nineIndex}>
            <CardHeader>
              <CardTitle>{defaultNineName(nine)}</CardTitle>
              <CardDescription>
                Confirm which nine this is, fix any misread scores, then check the totals.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label>Nine at {selectedCourse?.name ?? "the course"}</Label>
                <Select
                  items={[
                    { value: null, label: "— Choose nine —" },
                    ...(selectedCourse?.sets ?? []).map((entry) => ({
                      value: entry.id,
                      label: entry.name,
                    })),
                  ]}
                  value={nine.courseSetId}
                  onValueChange={(value) =>
                    updateNine(nineIndex, { courseSetId: value as string | null })
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={`Course nine for ${defaultNineName(nine)}`}
                    aria-invalid={nine.courseSetId === null}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={null}>— Choose nine —</SelectItem>
                    {(selectedCourse?.sets ?? []).map((entry) => {
                      const numbers = entry.holes.map((hole) => hole.number);
                      const range =
                        numbers.length > 0
                          ? ` · holes ${Math.min(...numbers)}–${Math.max(...numbers)}`
                          : "";
                      return (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}
                          {range}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="-mx-6 overflow-x-auto px-6">
                <table className="w-full min-w-max text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="p-2 pl-0 font-medium">Hole</th>
                      <th className="p-2 font-medium">Par</th>
                      {nine.playerNames.map((name) => (
                        <th key={name} className="p-2 text-center font-medium">
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {nine.holes.map((hole, holeIndex) => (
                      <tr key={hole.number} className="border-b">
                        <td className="p-2 pl-0 font-medium">{hole.number}</td>
                        <td className="p-2 text-muted-foreground">
                          {setParByNumber.get(hole.number) ?? hole.par}
                        </td>
                        {nine.playerNames.map((name, playerIndex) => (
                          <td key={name} className="p-2 text-center">
                            <Input
                              aria-label={`${name}'s score on hole ${hole.number}`}
                              className="h-9 w-14 text-center"
                              type="number"
                              inputMode="numeric"
                              min={1}
                              placeholder="–"
                              value={nine.scores[holeIndex]?.[playerIndex] ?? ""}
                              onChange={(event) =>
                                setScore(nineIndex, holeIndex, playerIndex, event.target.value)
                              }
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
                      {nine.playerNames.map((name, playerIndex) => (
                        <td key={name} className="p-2 text-center font-medium tabular-nums">
                          {computedTotals[playerIndex] ?? "–"}
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
              />
            </CardContent>
          </Card>
        );
      })}

      {roundNeedsCheck && (
        <Card>
          <CardHeader>
            <CardTitle>18-hole totals</CardTitle>
            <CardDescription>
              The card's grand totals, checked against every score above.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TotalsCheck rows={roundRows} choice={roundChoice} onChoice={setRoundChoice} />
          </CardContent>
        </Card>
      )}

      {mergeCandidate && (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitMerge aria-hidden="true" className="size-4" />
              Add to an existing outing?
            </CardTitle>
            <CardDescription>
              There's already an outing at {mergeCandidate.course.name} on{" "}
              {formatOutingDate(mergeCandidate.date)} on the same nine
              {mergeCandidate.sets.length === 1 ? "" : "s"} — this happens when one group splits
              across two scorecards.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
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
          </CardContent>
          <CardFooter className="gap-3">
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
          </CardFooter>
        </Card>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3">
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
              onClick={() => void submit()}
              disabled={submitting || roundProblems.length > 0 || nineProblems.length > 0}
            >
              <Send data-icon="inline-start" />
              {submitting ? "Saving…" : merging ? "Add to outing" : "Submit round"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
