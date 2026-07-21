import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
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
  TrainFront,
  TrainTrack,
  type LucideIcon,
} from "lucide-react";
import type { Honor, HonorOutingRef, HonorSlug } from "api";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveModal } from "@/components/responsive-modal";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { formatOutingDate, playerLabel } from "@/pages/outings";

type HonorMeta = {
  slug: HonorSlug;
  title: string;
  tagline: string;
  unclaimed: string;
  icon: LucideIcon;
  chip: string;
  dishonor?: boolean;
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
    slug: "par-train",
    title: "The Par Train",
    tagline: "Longest streak of holes at par or better.",
    unclaimed: "Three par-or-better holes in a row starts the engine.",
    icon: TrainFront,
    chip: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  },
  {
    slug: "groundhog-day",
    title: "Groundhog Day",
    tagline: "Longest streak of the same score to par.",
    unclaimed: "Nobody has repeated themselves three holes running.",
    icon: Repeat,
    chip: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  },
  {
    slug: "broken-record",
    title: "Broken Record",
    tagline: "Longest streak of the exact same score.",
    unclaimed: "No number has come up three times in a row yet.",
    icon: Disc3,
    chip: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
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
    slug: "bogey-train",
    title: "The Bogey Train",
    tagline: "Longest streak of holes at bogey or worse.",
    unclaimed: "No three-hole slide recorded. The brakes are holding.",
    icon: TrainTrack,
    chip: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
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
];

function formatToPar(toPar: number) {
  return toPar === 0 ? "E" : toPar > 0 ? `+${toPar}` : `${toPar}`;
}

function ordinal(n: number) {
  return `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
}

// Plural name of a score class ("bogeys", "pars") for the groundhog story.
function toParNoun(toPar: number) {
  if (toPar <= -3) return "albatrosses";
  if (toPar === -2) return "eagles";
  if (toPar === -1) return "birdies";
  if (toPar === 0) return "pars";
  if (toPar === 1) return "bogeys";
  if (toPar === 2) return "double bogeys";
  return `+${toPar}s`;
}

// Streaks may carry across consecutive outings; flag it when they do.
function streakSpan(honor: { startDate: string; latest: HonorOutingRef }) {
  return honor.startDate !== honor.latest.date ? ", carried across outings" : "";
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
    case "par-train":
      return {
        stat: `×${honor.holes}`,
        story: (
          <>
            {honor.holes} straight holes at par or better{streakSpan(honor)} — ending:
          </>
        ),
        outing: honor.latest,
      };
    case "groundhog-day":
      return {
        stat: `×${honor.holes}`,
        story: (
          <>
            {honor.holes} {toParNoun(honor.toPar)} in a row{streakSpan(honor)} — ending:
          </>
        ),
        outing: honor.latest,
      };
    case "broken-record":
      return {
        stat: `×${honor.holes}`,
        story: (
          <>
            Wrote down a {honor.score} on {honor.holes} straight holes{streakSpan(honor)} — ending:
          </>
        ),
        outing: honor.latest,
      };
    case "bogey-train":
      return {
        stat: `×${honor.holes}`,
        story: (
          <>
            {honor.holes} straight holes at bogey or worse{streakSpan(honor)} — ending:
          </>
        ),
        outing: honor.latest,
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
  return { since: `${year}-01-01`, until: `${year}-12-31` };
}

// The calendar year a range covers exactly, or null for a custom range.
function rangeYear(since: string, until: string) {
  const year = Number(since.slice(0, 4));
  const full = yearRange(year);
  return since === full.since && until === full.until ? year : null;
}

function formatRangeDate(date: string) {
  // Naive "YYYY-MM-DD"; anchor to noon so the formatter never slides it
  // across midnight into a neighboring day.
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// iOS gives date inputs UA styling (extra height, centered value); strip it
// so the fields match the buttons around them. Same recipe as review-round.
const DATE_INPUT_CLASS =
  "h-9 appearance-none justify-start text-left [&::-webkit-date-and-time-value]:m-0 [&::-webkit-date-and-time-value]:text-left";

// The calendar button at the top of the board: opens a ResponsiveModal
// (popover-style dialog on desktop, bottom sheet on phones) with quick
// buttons for the current and three previous years plus a custom from/to.
function DateRangeControl({
  since,
  until,
  onChange,
}: {
  since: string;
  until: string;
  onChange: (range: { since: string; until: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 4 }, (_, index) => currentYear - index);
  const activeYear = rangeYear(since, until);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <CalendarRange data-icon="inline-start" aria-hidden="true" />
        {activeYear ?? `${formatRangeDate(since)} – ${formatRangeDate(until)}`}
      </Button>
      <ResponsiveModal
        open={open}
        onOpenChange={setOpen}
        title="Date range"
        description="Honors are tallied from outings in this window."
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-4 gap-2">
            {years.map((year) => (
              <Button
                key={year}
                variant={year === activeYear ? "default" : "outline"}
                onClick={() => {
                  onChange(yearRange(year));
                  setOpen(false);
                }}
              >
                {year}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="honors-since">From</Label>
              <Input
                id="honors-since"
                type="date"
                value={since}
                max={until}
                onChange={(event) => {
                  if (event.target.value) onChange({ since: event.target.value, until });
                }}
                className={DATE_INPUT_CLASS}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="honors-until">To</Label>
              <Input
                id="honors-until"
                type="date"
                value={until}
                min={since}
                onChange={(event) => {
                  if (event.target.value) onChange({ since, until: event.target.value });
                }}
                className={DATE_INPUT_CLASS}
              />
            </div>
          </div>
        </div>
      </ResponsiveModal>
    </>
  );
}

export function HonorsPage({ since, until }: { since?: string; until?: string }) {
  const { client } = useAuth();
  const navigate = useNavigate();
  const defaults = yearRange(new Date().getFullYear());
  const range = { since: since ?? defaults.since, until: until ?? defaults.until };
  const [honors, setHonors] = useState<Honor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setHonors(null);
    setError(null);
    void client.api.honors.$get({ query: { since: range.since, until: range.until } }).then(
      async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError("Unable to load the honors board.");
          return;
        }
        const data = await response.json();
        setHonors(data.honors);
      },
      () => {
        if (!cancelled) setError("Unable to load the honors board.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, range.since, range.until]);

  function applyRange(next: { since: string; until: string }) {
    // Normalize a backwards pair (from > to) instead of rejecting it.
    const ordered = next.since <= next.until ? next : { since: next.until, until: next.since };
    void navigate({ to: "/honors", search: ordered });
  }

  const bySlug = new Map((honors ?? []).map((entry) => [entry.slug, entry]));
  const laurels = HONOR_METAS.filter((meta) => !meta.dishonor);
  const dishonors = HONOR_METAS.filter((meta) => meta.dishonor);
  const activeYear = rangeYear(range.since, range.until);

  return (
    <AppShell>
      <PageTitle>Honors · Scorecard</PageTitle>
      <PageHeading
        title="Honors"
        description={
          activeYear
            ? `Bragging rights (and public shame) from the ${activeYear} season.`
            : `Bragging rights (and public shame) from ${formatRangeDate(range.since)} to ${formatRangeDate(range.until)}.`
        }
        actions={<DateRangeControl since={range.since} until={range.until} onChange={applyRange} />}
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
