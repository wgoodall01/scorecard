import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Area, ComposedChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid } from "recharts";
import { AppShell, PageTitle } from "@/App";
import { GolfScore } from "@/components/golf-score";
import { ResponsiveSelect } from "@/components/responsive-select";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { useAuth } from "@/lib/auth-context";
import { formatOutingDate } from "@/pages/outings";

type HoleScore = {
  playerId: string;
  playerName: string | null;
  playerEmail: string | null;
  outingId: string;
  date: string;
  teeId: string;
  teeName: string;
  par: number;
  strokes: number;
};

type HoleTee = {
  id: string;
  name: string;
  gender: "m" | "f" | null;
  type: string | null;
  par: number;
  yardage: number | null;
};

type HoleStats = {
  hole: {
    number: number;
    courseId: string;
    courseName: string;
    setId: string;
    setName: string;
    pars: number[];
    par: number | null;
  };
  tees: HoleTee[];
  scores: HoleScore[];
};

function labelOf(score: HoleScore) {
  return score.playerName ?? score.playerEmail ?? "Unnamed golfer";
}

function useHoleStats(setId: string, number: number) {
  const { client } = useAuth();
  const [data, setData] = useState<HoleStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setData(null);
    setError(null);
    void client.api["course-sets"][":setId"].holes[":number"]
      .$get({ param: { setId, number: String(number) } })
      .then(
        async (response) => {
          if (cancelled) return;
          if (!response.ok) {
            setError("Unable to load this hole.");
            return;
          }
          setData((await response.json()) as HoleStats);
        },
        () => {
          if (!cancelled) setError("Unable to load this hole.");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [client, setId, number]);

  return { data, error };
}

const chartConfig = {
  mine: { label: "You", color: "var(--chart-2)" },
  others: { label: "Everyone else", color: "var(--muted-foreground)" },
  // A deliberately non-green hue for the compared player, so it reads
  // distinctly against the all-green brand palette (and for CVD).
  compare: { label: "Selected", color: "oklch(0.62 0.2 280)" },
} satisfies ChartConfig;

// A normal curve scaled so its area equals n (each dot is one unit, bin width
// 1), so the fit's height sits on the same scale as this series' dot column.
function fitNormal(strokes: number[], domain: [number, number]) {
  const n = strokes.length;
  if (n < 3) return [];
  const mean = strokes.reduce((sum, v) => sum + v, 0) / n;
  const variance = strokes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std <= 0) return [];
  const points: { x: number; y: number }[] = [];
  for (let x = domain[0]; x <= domain[1] + 0.001; x += 0.1) {
    const pdf = Math.exp(-((x - mean) ** 2) / (2 * std * std)) / (std * Math.sqrt(2 * Math.PI));
    points.push({ x: Math.round(x * 10) / 10, y: pdf * n });
  }
  return points;
}

// Half the gap between the two series' columns at each stroke value. At 0.25
// the within-value gap (0.5) equals the between-value gap, so all columns sit
// on one uniform grid, alternating green (you) / other by stroke value rather
// than clustering tightly around each x tick.
const DOT_OFFSET = 0.25;

// Stack a series' scores into an evenly-spaced dot column per stroke value,
// shifted by `offset` so it sits beside the other series.
function columnDots(list: HoleScore[], offset: number) {
  const byValue = new Map<number, HoleScore[]>();
  for (const s of list) {
    const arr = byValue.get(s.strokes) ?? [];
    arr.push(s);
    byValue.set(s.strokes, arr);
  }
  const dots: {
    x: number;
    y: number;
    strokes: number;
    par: number;
    label: string;
    date: string;
  }[] = [];
  let tallest = 0;
  for (const [value, arr] of byValue) {
    tallest = Math.max(tallest, arr.length);
    [...arr]
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((s, index) => {
        dots.push({
          x: value + offset,
          y: index + 1,
          strokes: s.strokes,
          par: s.par,
          label: labelOf(s),
          date: s.date,
        });
      });
  }
  return { dots, tallest };
}

// ZAxis area 46 → radius ≈ 3.83; the "other" series draws 20% smaller, same
// center (recharts has no per-series size, so this Scatter takes a custom
// shape). fill/fillOpacity are injected from the Scatter's own props.
const OTHER_DOT_RADIUS = 3.05;
function SmallDot(props: { cx?: number; cy?: number; fill?: string; fillOpacity?: number }) {
  const { cx, cy, fill, fillOpacity } = props;
  if (cx == null || cy == null) return null;
  return <circle cx={cx} cy={cy} r={OTHER_DOT_RADIUS} fill={fill} fillOpacity={fillOpacity} />;
}

// Two dot-histogram distributions side by side — yours (green) versus either
// everyone else or one selected player — each with its own fitted normal
// curve.
function DistributionChart({
  scores,
  myPlayerId,
  comparePlayerId,
}: {
  scores: HoleScore[];
  myPlayerId: string | null;
  comparePlayerId: string | null;
}) {
  const { mineDots, otherDots, mineCurve, otherCurve, ticks, domain, yMax } = useMemo(() => {
    const all = scores.map((s) => s.strokes);
    const domain: [number, number] = [Math.min(...all) - 1, Math.max(...all) + 1];

    const mineScores = myPlayerId ? scores.filter((s) => s.playerId === myPlayerId) : [];
    const otherScores = comparePlayerId
      ? scores.filter((s) => s.playerId === comparePlayerId)
      : scores.filter((s) => s.playerId !== myPlayerId);

    const mine = columnDots(mineScores, -DOT_OFFSET);
    const other = columnDots(otherScores, DOT_OFFSET);
    const mineCurve = fitNormal(
      mineScores.map((s) => s.strokes),
      domain,
    );
    const otherCurve = fitNormal(
      otherScores.map((s) => s.strokes),
      domain,
    );

    const ticks: number[] = [];
    for (let t = Math.ceil(domain[0]); t <= Math.floor(domain[1]); t += 1) ticks.push(t);

    const peak = [...mineCurve, ...otherCurve].reduce((max, point) => Math.max(max, point.y), 0);
    const yMax = Math.max(mine.tallest, other.tallest, peak) * 1.15 + 0.3;

    return {
      mineDots: mine.dots,
      otherDots: other.dots,
      mineCurve,
      otherCurve,
      ticks,
      domain,
      yMax,
    };
  }, [scores, myPlayerId, comparePlayerId]);

  const otherColor = comparePlayerId ? "var(--color-compare)" : "var(--color-others)";

  return (
    <ChartContainer config={chartConfig} className="aspect-[3/2] w-full sm:aspect-[5/2]">
      <ComposedChart margin={{ left: 4, right: 12, top: 12, bottom: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          type="number"
          dataKey="x"
          domain={domain}
          ticks={ticks}
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          label={{ value: "Strokes", position: "insideBottom", offset: -2, fontSize: 11 }}
        />
        <YAxis
          type="number"
          dataKey="y"
          domain={[0, yMax]}
          width={28}
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          tickCount={4}
        />
        <ZAxis range={[46, 46]} />
        {otherCurve.length > 0 && (
          <Area
            data={otherCurve}
            dataKey="y"
            type="monotone"
            dot={false}
            activeDot={false}
            stroke="none"
            fill={otherColor}
            fillOpacity={0.16}
            isAnimationActive={false}
          />
        )}
        {mineCurve.length > 0 && (
          <Area
            data={mineCurve}
            dataKey="y"
            type="monotone"
            dot={false}
            activeDot={false}
            stroke="none"
            fill="var(--color-mine)"
            fillOpacity={0.18}
            isAnimationActive={false}
          />
        )}
        <Scatter
          data={otherDots}
          fill={otherColor}
          fillOpacity={0.5}
          shape={<SmallDot />}
          isAnimationActive={false}
        />
        <Scatter
          data={mineDots}
          fill="var(--color-mine)"
          fillOpacity={0.9}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}

function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

// Population standard deviation of a player's scores.
function stddev(values: number[]) {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

const CONSISTENCY_MIN_ROUNDS = 3;

export function HoleStatsPage({ setId, number }: { setId: string; number: number }) {
  const { data, error } = useHoleStats(setId, number);
  const { client, profile } = useAuth();
  const myId = profile?.id ?? null;

  // The tee list shows yardages for the golfer's gender (the /me profile
  // doesn't carry it, so fetch the full golfer row); default to men's.
  const [gender, setGender] = useState<"m" | "f">("m");
  useEffect(() => {
    if (!client || !profile) return;
    let cancelled = false;
    void client.api.golfers[":id"]
      .$get({ param: { id: profile.id } })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const { golfer } = await response.json();
        if (golfer.gender) setGender(golfer.gender);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, profile]);
  // Tees for this golfer's gender, plus ungendered markers (combos), longest
  // first (the API already sorts by yardage).
  const genderTees = (data?.tees ?? []).filter(
    (tee) => tee.gender === gender || tee.gender === null,
  );

  // "Compare to" narrows the distribution from you-vs-everyone to
  // you-vs-one-player. Every other golfer who has a score on this hole is an
  // option; cleared = everyone.
  const [compareId, setCompareId] = useState<string | null>(null);
  const comparePlayers = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, string>();
    for (const s of data.scores) {
      if (s.playerId !== myId && !seen.has(s.playerId)) seen.set(s.playerId, labelOf(s));
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data, myId]);
  // A comparison referencing a player no longer in the list resets to everyone.
  useEffect(() => {
    if (compareId && !comparePlayers.some((player) => player.value === compareId)) {
      setCompareId(null);
    }
  }, [compareId, comparePlayers]);
  const compareLabel = comparePlayers.find((player) => player.value === compareId)?.label ?? null;

  const stats = useMemo(() => {
    if (!data || data.scores.length === 0) return null;
    const scores = data.scores;
    const n = scores.length;
    const average = scores.reduce((sum, s) => sum + s.strokes, 0) / n;
    const vsPar = scores.reduce((sum, s) => sum + (s.strokes - s.par), 0) / n;

    // Best / worst by strokes relative to par (pars differ by tee); ties
    // break to the more recent round.
    const byQuality = [...scores].sort(
      (a, b) => a.strokes - a.par - (b.strokes - b.par) || b.date.localeCompare(a.date),
    );
    const best = byQuality[0];
    const worst = byQuality[byQuality.length - 1];

    // Per-player consistency (needs a few rounds to mean anything).
    const byPlayer = new Map<string, HoleScore[]>();
    for (const s of scores) {
      const list = byPlayer.get(s.playerId) ?? [];
      list.push(s);
      byPlayer.set(s.playerId, list);
    }
    const players = [...byPlayer.entries()]
      .filter(([, list]) => list.length >= CONSISTENCY_MIN_ROUNDS)
      .map(([playerId, list]) => ({
        playerId,
        label: labelOf(list[0]),
        rounds: list.length,
        average: list.reduce((sum, s) => sum + s.strokes, 0) / list.length,
        deviation: stddev(list.map((s) => s.strokes)),
      }))
      .sort((a, b) => a.deviation - b.deviation);
    const mostConsistent = players[0] ?? null;
    const leastConsistent = players.length >= 2 ? players[players.length - 1] : null;

    // Your line.
    const mine = myId ? scores.filter((s) => s.playerId === myId) : [];
    const myAverage =
      mine.length > 0 ? mine.reduce((sum, s) => sum + s.strokes, 0) / mine.length : null;
    const myBest = mine.length > 0 ? [...mine].sort((a, b) => a.strokes - b.strokes)[0] : null;

    // Scoring breakdown relative to each score's own par.
    const breakdown = { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0 };
    for (const s of scores) {
      const delta = s.strokes - s.par;
      if (delta <= -2) breakdown.eagle += 1;
      else if (delta === -1) breakdown.birdie += 1;
      else if (delta === 0) breakdown.par += 1;
      else if (delta === 1) breakdown.bogey += 1;
      else breakdown.double += 1;
    }

    return {
      n,
      average,
      vsPar,
      best,
      worst,
      mostConsistent,
      leastConsistent,
      mine,
      myAverage,
      myBest,
      breakdown,
      players: byPlayer.size,
    };
  }, [data, myId]);

  const hole = data?.hole;
  const parLabel = hole
    ? hole.pars.length > 1
      ? `Par ${hole.pars[0]}–${hole.pars[hole.pars.length - 1]}`
      : hole.par !== null
        ? `Par ${hole.par}`
        : ""
    : "";

  return (
    <AppShell>
      <PageTitle>
        {hole ? `Hole ${hole.number} · ${hole.setName} · Scorecard` : "Hole · Scorecard"}
      </PageTitle>
      <nav aria-label="Breadcrumb" className="mb-4 flex flex-wrap items-center gap-1.5 text-sm">
        <Link
          to="/courses"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          Courses
        </Link>
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        {hole ? (
          <Link
            to="/courses/$id"
            params={{ id: hole.courseId }}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            {hole.courseName}
          </Link>
        ) : (
          <span className="text-muted-foreground">Course</span>
        )}
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">
          {hole ? `${hole.setName} · Hole ${hole.number}` : "Hole"}
        </span>
      </nav>

      <div className="mb-8 min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Hole {hole?.number ?? ""}</h1>
        {hole && (
          <p className="mt-1 text-sm text-muted-foreground">
            {hole.setName}
            {parLabel && ` · ${parLabel}`}
          </p>
        )}
      </div>

      {!data && !error && <p className="text-sm text-muted-foreground">Loading hole…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {data && data.scores.length === 0 && (
        <section className="rounded-xl border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          No scores have been recorded on this hole yet.
        </section>
      )}

      {data && stats && hole && (
        <div className="flex flex-col gap-6">
          <section className="rounded-xl border bg-card">
            <div className="border-b p-5">
              <h2 className="font-medium">Score distribution</h2>
            </div>
            <div className="flex flex-col gap-2 p-5">
              <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2.5 rounded-full"
                    style={{ background: "var(--chart-2)" }}
                  />
                  You
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2.5 rounded-full"
                    style={{
                      background: compareId ? "oklch(0.62 0.2 280)" : "var(--muted-foreground)",
                    }}
                  />
                  {compareLabel ?? "Everyone else"}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-4 rounded-sm border"
                    style={{ background: "var(--muted-foreground)", opacity: 0.25 }}
                  />
                  Normal fit
                </span>
              </div>
              <DistributionChart
                scores={data.scores}
                myPlayerId={myId}
                comparePlayerId={compareId}
              />
              <p className="text-center text-xs text-muted-foreground">
                Each dot is one round; taller columns are more common scores — your rounds versus{" "}
                {compareLabel ?? "everyone else's"}.
              </p>
              {comparePlayers.length > 0 && (
                <div className="mt-2 flex items-center justify-center gap-2">
                  <span className="text-xs text-muted-foreground">Compare to</span>
                  <ResponsiveSelect
                    value={compareId}
                    onValueChange={setCompareId}
                    options={comparePlayers}
                    searchable
                    clearable
                    placeholder="Everyone else"
                    ariaLabel="Compare to another golfer"
                    title="Compare to"
                    triggerClassName="w-48"
                  />
                </div>
              )}
            </div>
          </section>

          {genderTees.length > 0 && (
            <section className="rounded-xl border bg-card">
              <div className="border-b p-5">
                <h2 className="font-medium">Tees</h2>
              </div>
              <div className="overflow-x-auto p-5">
                <div className="flex divide-x">
                  {genderTees.map((tee) => (
                    <div
                      key={tee.id}
                      className="flex shrink-0 flex-col gap-0.5 px-5 first:pl-0 last:pr-0"
                    >
                      <span className="text-xs font-medium whitespace-nowrap text-muted-foreground">
                        {tee.name}
                      </span>
                      <span className="text-lg font-semibold tabular-nums">
                        {tee.yardage != null ? tee.yardage : "—"}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">yds</span>
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        Par {tee.par}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Scoring average">
              <p className="text-2xl font-semibold tabular-nums">{stats.average.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">
                {stats.vsPar >= 0 ? "+" : ""}
                {stats.vsPar.toFixed(2)} vs par · {stats.n} {stats.n === 1 ? "round" : "rounds"}
              </p>
            </StatCard>

            <StatCard label="Your average">
              {stats.myAverage !== null && stats.myBest ? (
                <>
                  <p className="text-2xl font-semibold tabular-nums text-[var(--chart-3)]">
                    {stats.myAverage.toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {stats.mine.length} {stats.mine.length === 1 ? "round" : "rounds"} · best{" "}
                    <GolfScore
                      score={stats.myBest.strokes}
                      par={stats.myBest.par}
                      className="mx-0.5 align-middle text-xs"
                    />
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">You haven't played this hole yet.</p>
              )}
            </StatCard>

            <StatCard label="Best score">
              <Link
                to="/outings/$id"
                params={{ id: stats.best.outingId }}
                className="flex items-center gap-2.5 py-1 hover:underline"
              >
                <GolfScore
                  score={stats.best.strokes}
                  par={stats.best.par}
                  className="shrink-0 text-lg font-semibold"
                />
                <span className="min-w-0 truncate text-sm">{labelOf(stats.best)}</span>
              </Link>
              <p className="text-xs text-muted-foreground">{formatOutingDate(stats.best.date)}</p>
            </StatCard>

            <StatCard label="Worst score">
              <Link
                to="/outings/$id"
                params={{ id: stats.worst.outingId }}
                className="flex items-center gap-2.5 py-1 hover:underline"
              >
                <GolfScore
                  score={stats.worst.strokes}
                  par={stats.worst.par}
                  className="shrink-0 text-lg font-semibold"
                />
                <span className="min-w-0 truncate text-sm">{labelOf(stats.worst)}</span>
              </Link>
              <p className="text-xs text-muted-foreground">{formatOutingDate(stats.worst.date)}</p>
            </StatCard>

            <StatCard label="Most consistent">
              {stats.mostConsistent ? (
                <>
                  <p className="truncate font-semibold">
                    <Link
                      to="/golfers/$id"
                      params={{ id: stats.mostConsistent.playerId }}
                      className="hover:underline"
                    >
                      {stats.mostConsistent.label}
                    </Link>
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    ±{stats.mostConsistent.deviation.toFixed(2)} · avg{" "}
                    {stats.mostConsistent.average.toFixed(1)} over {stats.mostConsistent.rounds}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Needs a player with {CONSISTENCY_MIN_ROUNDS}+ rounds.
                </p>
              )}
            </StatCard>

            <StatCard label="Least consistent">
              {stats.leastConsistent ? (
                <>
                  <p className="truncate font-semibold">
                    <Link
                      to="/golfers/$id"
                      params={{ id: stats.leastConsistent.playerId }}
                      className="hover:underline"
                    >
                      {stats.leastConsistent.label}
                    </Link>
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    ±{stats.leastConsistent.deviation.toFixed(2)} · avg{" "}
                    {stats.leastConsistent.average.toFixed(1)} over {stats.leastConsistent.rounds}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Needs two players with {CONSISTENCY_MIN_ROUNDS}+ rounds.
                </p>
              )}
            </StatCard>

            <StatCard label="Scoring mix">
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums">
                {stats.breakdown.eagle > 0 && <span>Eagle+ {stats.breakdown.eagle}</span>}
                <span>Birdie {stats.breakdown.birdie}</span>
                <span>Par {stats.breakdown.par}</span>
                <span>Bogey {stats.breakdown.bogey}</span>
                <span>Dbl+ {stats.breakdown.double}</span>
              </div>
            </StatCard>

            <StatCard label="Players">
              <p className="text-2xl font-semibold tabular-nums">{stats.players}</p>
              <p className="text-xs text-muted-foreground">have a score here</p>
            </StatCard>
          </section>

          <section className="rounded-xl border bg-card">
            <div className="border-b p-5">
              <h2 className="font-medium">Every score</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="p-3 pl-5 font-medium">Score</th>
                    <th className="p-3 font-medium">Golfer</th>
                    <th className="p-3 font-medium">Tee</th>
                    <th className="p-3 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.scores]
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .map((s, index) => {
                      const mine = s.playerId === myId;
                      return (
                        <tr
                          key={`${s.outingId}-${s.playerId}-${index}`}
                          className="border-t transition-colors hover:bg-muted/50"
                        >
                          <td className="p-3 pl-5">
                            <GolfScore score={s.strokes} par={s.par} />
                          </td>
                          <td className="p-3">
                            <Link
                              to="/golfers/$id"
                              params={{ id: s.playerId }}
                              className={
                                mine
                                  ? "font-medium text-[var(--chart-3)] hover:underline"
                                  : "hover:underline"
                              }
                            >
                              {labelOf(s)}
                              {mine && " (you)"}
                            </Link>
                          </td>
                          <td className="p-3 text-muted-foreground">{s.teeName}</td>
                          <td className="p-3">
                            <Link
                              to="/outings/$id"
                              params={{ id: s.outingId }}
                              className="text-muted-foreground hover:text-foreground hover:underline"
                            >
                              {formatOutingDate(s.date)}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}
