import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Anchor,
  Bird,
  Bomb,
  CalendarHeart,
  CalendarRange,
  Disc3,
  Flame,
  Medal,
  Repeat,
  Rocket,
  Snowflake,
  Target,
  TrendingDown,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Honor, HonorOutingRef, HonorSlug } from "api";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveModal } from "@/components/responsive-modal";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { apiQuery } from "@/lib/query";
import { formatOutingDate, playerLabel } from "@/pages/outings";

type HonorMeta = {
  slug: HonorSlug;
  title: string;
  tagline: string;
  unclaimed: string;
  icon: LucideIcon;
  chip: string;
  dishonor?: boolean;
  // Streak honors render in their own section; a dishonorable streak (the
  // cold streak) keeps the destructive card styling there.
  streak?: boolean;
};

const HONOR_METAS: HonorMeta[] = [
  {
    slug: "medalist",
    title: "The Medalist",
    tagline: "Lowest 18-hole round, against par.",
    unclaimed: "Nobody has gone low yet. The course remains undefeated.",
    icon: Medal,
    chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  {
    slug: "hot-nine",
    title: "Hot Nine",
    tagline: "Best single nine, against par.",
    unclaimed: "No nine has caught fire yet.",
    icon: Flame,
    chip: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  },
  {
    slug: "birdie-machine",
    title: "Birdie Machine",
    tagline: "Most holes under par.",
    unclaimed: "Zero birdies so far. The birds are safe.",
    icon: Bird,
    chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  {
    slug: "par-machine",
    title: "Steady Hand",
    tagline: "Highest share of holes at par or better.",
    unclaimed: "Needs 18 holes played — and at least one par.",
    icon: Target,
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  {
    slug: "metronome",
    title: "The Metronome",
    tagline: "Most consistent score, hole after hole.",
    unclaimed: "Consistency requires evidence: 18 holes minimum.",
    icon: Activity,
    chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  {
    slug: "iron-golfer",
    title: "Iron Golfer",
    tagline: "Most outings played.",
    unclaimed: "Somebody has to show up first.",
    icon: CalendarHeart,
    chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  },
  {
    slug: "comeback-kid",
    title: "Comeback Kid",
    tagline: "Biggest front-nine-to-back-nine turnaround.",
    unclaimed: "No redemption arcs recorded yet.",
    icon: Rocket,
    chip: "bg-green-500/15 text-green-600 dark:text-green-400",
  },
  {
    slug: "crater",
    title: "The Crater",
    tagline: "Worst single hole. Triple bogey territory.",
    unclaimed: "No craters. Everyone is keeping it together — for now.",
    icon: Bomb,
    chip: "bg-destructive/10 text-destructive",
    dishonor: true,
  },
  {
    slug: "snowman",
    title: "Snowman Collector",
    tagline: "Most scores of 8 or worse. ⛄",
    unclaimed: "No snowmen this season. Unseasonably warm.",
    icon: Snowflake,
    chip: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    dishonor: true,
  },
  {
    slug: "anchor",
    title: "The Anchor",
    tagline: "Highest average over par per hole.",
    unclaimed: "Nobody sits at the bottom until two golfers qualify.",
    icon: Anchor,
    chip: "bg-stone-500/15 text-stone-600 dark:text-stone-400",
    dishonor: true,
  },
  {
    slug: "hot-streak",
    title: "The Heater",
    tagline: "Most consecutive holes at par or better.",
    unclaimed: "Nobody has strung two par-or-better holes together yet.",
    icon: Zap,
    chip: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
    streak: true,
  },
  {
    slug: "cold-streak",
    title: "The Skid",
    tagline: "Most consecutive holes at bogey or worse.",
    unclaimed: "No skids on record. Suspiciously tidy golf.",
    icon: TrendingDown,
    chip: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
    dishonor: true,
    streak: true,
  },
  {
    slug: "groundhog-day",
    title: "Groundhog Day",
    tagline: "Most consecutive holes with the same score to par.",
    unclaimed: "No déjà vu yet — nobody has repeated themselves against par.",
    icon: Repeat,
    chip: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    streak: true,
  },
  {
    slug: "broken-record",
    title: "Broken Record",
    tagline: "Most consecutive holes with the exact same score.",
    unclaimed: "Nobody has carded the same number twice running.",
    icon: Disc3,
    chip: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
    streak: true,
  },
];

function formatToPar(toPar: number) {
  return toPar === 0 ? "E" : toPar > 0 ? `+${toPar}` : `${toPar}`;
}

function ordinal(n: number) {
  return `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
}

// The everyday name of a score relative to par, for the groundhog-day story.
function toParNoun(toPar: number) {
  if (toPar <= -3) return "an albatross";
  if (toPar === -2) return "an eagle";
  if (toPar === -1) return "a birdie";
  if (toPar === 0) return "a par";
  if (toPar === 1) return "a bogey";
  if (toPar === 2) return "a double bogey";
  if (toPar === 3) return "a triple bogey";
  return `+${toPar}`;
}

// "7 straight holes", with the multi-outing carry called out when a streak
// spanned more than one round.
function streakSpan(holes: number, outings: number) {
  return `${holes} straight holes${outings > 1 ? ` across ${outings} outings` : ""}`;
}

function OutingLink({ outing }: { outing: HonorOutingRef }) {
  return (
    <Link
      to="/outings/$id"
      params={{ id: outing.id }}
      className="whitespace-nowrap underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
    >
      {formatOutingDate(outing.date)}
    </Link>
  );
}

// The big stat plus the story behind it — the custom bit of each card. The
// referenced outing (when there is one) renders on its own final line.
function honorDetail(honor: Honor): {
  stat: React.ReactNode;
  story: React.ReactNode;
  outing?: HonorOutingRef;
} {
  switch (honor.slug) {
    case "medalist":
      return {
        stat: formatToPar(honor.toPar),
        story: (
          <>
            Shot {honor.strokes} over {honor.holes} holes.
          </>
        ),
        outing: honor.outing,
      };
    case "hot-nine":
      return {
        stat: formatToPar(honor.toPar),
        story: (
          <>
            Torched {honor.nineName} in {honor.strokes} (par {honor.par}).
          </>
        ),
        outing: honor.outing,
      };
    case "birdie-machine":
      return {
        stat: `×${honor.birdies}`,
        story: (
          <>
            {honor.birdies === 1 ? "One hole" : `${honor.birdies} holes`} under par — most recently:
          </>
        ),
        outing: honor.latest,
      };
    case "par-machine":
      return {
        stat: `${Math.round((honor.pars / honor.holes) * 100)}%`,
        story: (
          <>
            {honor.pars} of {honor.holes} holes at par or better.
          </>
        ),
      };
    case "metronome":
      return {
        stat: `±${honor.stdev.toFixed(1)}`,
        story: <>Standard deviation vs par across {honor.holes} holes. Tick, tock.</>,
      };
    case "iron-golfer":
      return {
        stat: `×${honor.outings}`,
        story: (
          <>{honor.outings === 1 ? "One outing" : `${honor.outings} outings`} — most recently:</>
        ),
        outing: honor.latest,
      };
    case "comeback-kid":
      return {
        stat: `−${honor.swing}`,
        story: (
          <>
            Front nine {formatToPar(honor.frontToPar)}, back nine {formatToPar(honor.backToPar)}.
          </>
        ),
        outing: honor.outing,
      };
    case "crater":
      return {
        stat: `+${honor.overPar}`,
        story: (
          <>
            A {honor.strokes} on the par-{honor.par} {ordinal(honor.holeNumber)} ({honor.nineName}
            ).
          </>
        ),
        outing: honor.outing,
      };
    case "snowman":
      return {
        stat: `⛄ ×${honor.count}`,
        story: (
          <>
            {honor.count === 1 ? "One score" : `${honor.count} scores`} of 8+, topping out at{" "}
            {honor.worst} — most recently:
          </>
        ),
        outing: honor.latest,
      };
    case "anchor":
      return {
        stat: `+${honor.avgOverPar.toFixed(1)}`,
        story: <>Per hole, averaged over {honor.holes} holes. Somebody has to steady the ship.</>,
      };
    case "hot-streak":
      return {
        stat: `×${honor.holes}`,
        story: <>{streakSpan(honor.holes, honor.outings)} at par or better — ending:</>,
        outing: honor.latest,
      };
    case "cold-streak":
      return {
        stat: `×${honor.holes}`,
        story: <>{streakSpan(honor.holes, honor.outings)} at bogey or worse — ending:</>,
        outing: honor.latest,
      };
    case "groundhog-day":
      return {
        stat: `×${honor.holes}`,
        story: (
          <>
            Carded {toParNoun(honor.toPar)} on {streakSpan(honor.holes, honor.outings)} — ending:
          </>
        ),
        outing: honor.latest,
      };
    case "broken-record":
      return {
        stat: `×${honor.holes}`,
        story: (
          <>
            A {honor.strokes} on {streakSpan(honor.holes, honor.outings)} — ending:
          </>
        ),
        outing: honor.latest,
      };
  }
}

function HonorCard({ meta, honor }: { meta: HonorMeta; honor: Honor | undefined }) {
  const Icon = meta.icon;
  const detail = honor ? honorDetail(honor) : null;
  return (
    <section
      className={cn(
        "flex flex-col rounded-xl border bg-card",
        meta.dishonor && "border-destructive/30",
      )}
    >
      <div className="flex items-start gap-3 p-5">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            meta.chip,
          )}
        >
          <Icon aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0">
          <h3 className="font-medium">{meta.title}</h3>
          <p className="text-sm text-muted-foreground">{meta.tagline}</p>
        </div>
      </div>
      {honor && detail ? (
        <div className="flex flex-1 items-center justify-between gap-4 border-t p-5 pt-4">
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <Link
              to="/golfers/$id"
              params={{ id: honor.holder.id }}
              className="w-fit font-medium hover:underline"
            >
              {playerLabel(honor.holder)}
            </Link>
            <p className="text-muted-foreground">{detail.story}</p>
            {detail.outing && (
              <p className="text-xs text-muted-foreground">
                <OutingLink outing={detail.outing} /> · {detail.outing.courseName}
              </p>
            )}
          </div>
          <p className="shrink-0 self-center text-2xl font-semibold tabular-nums">{detail.stat}</p>
        </div>
      ) : (
        <div className="flex-1 border-t border-dashed p-5 pt-4">
          <p className="text-sm text-muted-foreground italic">{meta.unclaimed}</p>
        </div>
      )}
    </section>
  );
}

function yearRange(year: number) {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

// "2026" for an exact calendar year, otherwise "Mar 1 – Sep 30, 2026"-style.
function formatRange(from: string, to: string) {
  const year = from.slice(0, 4);
  if (from === `${year}-01-01` && to === `${year}-12-31`) return year;
  const label = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  return `${label(from)} – ${label(to)}`;
}

// The calendar button + responsive sheet/popover holding the range picker:
// quick buttons for this year and the three before it, plus free-form
// from/to date inputs.
function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 4 }, (_, index) => currentYear - index);

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        aria-label="Change date range"
        title="Change date range"
        onClick={() => setOpen(true)}
      >
        <CalendarRange aria-hidden="true" />
      </Button>
      <ResponsiveModal
        open={open}
        onOpenChange={setOpen}
        title="Date range"
        description="Honors are tallied from outings in this range."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {years.map((year) => {
              const range = yearRange(year);
              const active = from === range.from && to === range.to;
              return (
                <Button
                  key={year}
                  variant={active ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    onChange(range);
                    setOpen(false);
                  }}
                >
                  {year}
                </Button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="honors-from">From</Label>
              <Input
                id="honors-from"
                type="date"
                value={from}
                max={to}
                onChange={(event) => {
                  if (event.target.value) onChange({ from: event.target.value, to });
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="honors-to">To</Label>
              <Input
                id="honors-to"
                type="date"
                value={to}
                min={from}
                onChange={(event) => {
                  if (event.target.value) onChange({ from, to: event.target.value });
                }}
              />
            </div>
          </div>
        </div>
      </ResponsiveModal>
    </>
  );
}

export function HonorsPage({ from: fromParam, to: toParam }: { from?: string; to?: string }) {
  const navigate = useNavigate();

  const defaults = yearRange(new Date().getFullYear());
  const from = fromParam ?? defaults.from;
  const to = toParam ?? defaults.to;

  // The range is part of the query key, so picking a new one refetches (and
  // keeps the previous board cached).
  const honorsQuery = useQuery(apiQuery(api.honors.$get, { query: { from, to } }));
  const honors: Honor[] | null = honorsQuery.data?.honors ?? null;
  const error = honorsQuery.error !== null ? "Unable to load the honors board." : null;

  const setRange = (range: { from: string; to: string }) => {
    // The current-year default keeps a clean, param-free URL.
    const isDefault = range.from === defaults.from && range.to === defaults.to;
    void navigate({
      to: "/honors",
      search: isDefault ? {} : range,
      replace: true,
    });
  };

  const bySlug = new Map((honors ?? []).map((entry) => [entry.slug, entry]));
  const laurels = HONOR_METAS.filter((meta) => !meta.dishonor && !meta.streak);
  const streaks = HONOR_METAS.filter((meta) => meta.streak);
  const dishonors = HONOR_METAS.filter((meta) => meta.dishonor && !meta.streak);

  return (
    <AppShell>
      <PageTitle>Honors · Scorecard</PageTitle>
      <PageHeading
        title="Honors"
        description={`Bragging rights (and public shame) from ${formatRange(from, to)}.`}
        actions={<DateRangePicker from={from} to={to} onChange={setRange} />}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!honors && !error && <p className="text-sm text-muted-foreground">Tallying the board…</p>}
      {honors && (
        <div className="flex flex-col gap-8">
          <div className="grid gap-4 sm:grid-cols-2">
            {laurels.map((meta) => (
              <HonorCard key={meta.slug} meta={meta} honor={bySlug.get(meta.slug)} />
            ))}
          </div>
          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Streaks</h2>
              <p className="text-sm text-muted-foreground">
                Runs of consecutive holes — and they carry over from one outing to the next.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {streaks.map((meta) => (
                <HonorCard key={meta.slug} meta={meta} honor={bySlug.get(meta.slug)} />
              ))}
            </div>
          </section>
          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Dishonors</h2>
              <p className="text-sm text-muted-foreground">
                Somebody has to win these too. It's in the rules.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {dishonors.map((meta) => (
                <HonorCard key={meta.slug} meta={meta} honor={bySlug.get(meta.slug)} />
              ))}
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}
