import { Fragment } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  BarChart3,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  ExternalLink,
  Flag,
  Pencil,
  Plus,
} from "lucide-react";
import type { Tee } from "api";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { LoadMore } from "@/components/load-more";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { apiInfiniteQuery, apiMutation, apiQuery, apiQueryKey, pagedRecords } from "@/lib/query";
import { TEE_LABELS, TEES } from "@/lib/tees";
import { nineLabel } from "@/pages/outings";

export type CourseTee = {
  id: string;
  name: string;
  gender: "m" | "f" | null;
  type: Tee | null;
  courseRating: number | null;
  slopeRating: number | null;
  holes: { id: string; number: number; par: number; yardage: number | null }[];
};

export type CourseWithNines = {
  id: string;
  name: string;
  location: string | null;
  ncrdbFacilityId: number | null;
  sets: {
    id: string;
    name: string;
    // "This nine is the front/back half of THIS USGA-rated 18-hole course."
    usgaCourseId: number | null;
    usgaCourseNine: "front" | "back" | null;
    tees: CourseTee[];
  }[];
};

// Longest tees first: the app-level type order, untyped tees last, then name.
export function sortTees<TTee extends { name: string; type: Tee | null }>(tees: TTee[]): TTee[] {
  const rank = (tee: TTee) => (tee.type === null ? TEES.length : TEES.indexOf(tee.type));
  return [...tees].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// Nines in play order: by the hole number they start on, so a "Front"/"Back"
// pair reads 1-9 then 10-18 rather than alphabetically. A nine's start is the
// lowest hole number across its tees (holes hang off tees, not the nine).
// Hole-less nines sort last; ties fall back to the name.
export function sortNines<TSet extends { name: string; tees: { holes: { number: number }[] }[] }>(
  sets: TSet[],
): TSet[] {
  const firstHole = (set: TSet) => {
    const numbers = set.tees.flatMap((tee) => tee.holes.map((hole) => hole.number));
    return numbers.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...numbers);
  };
  return [...sets].sort((a, b) => firstHole(a) - firstHole(b) || a.name.localeCompare(b.name));
}

export function teeLabel(tee: { name: string; gender: "m" | "f" | null }) {
  return tee.gender === null ? tee.name : `${tee.name} (${tee.gender.toUpperCase()})`;
}

// Sort/group order for gender: men's, then women's, then ungendered.
function genderOrder(gender: "m" | "f" | null): number {
  return gender === "m" ? 0 : gender === "f" ? 1 : 2;
}

// The tee to headline for THIS golfer on a nine: their preferred TYPE at their
// gender if it exists, then that type at any gender, then a standard tee at
// their gender, then any rated tee, then whatever's first. Mirrors how the
// capture review defaults a golfer's tee.
function preferredTeeFor(
  tees: CourseTee[],
  preferredType: Tee | null,
  gender: "m" | "f" | null,
): CourseTee | null {
  const rated = tees.filter((tee) => tee.courseRating !== null);
  return (
    (preferredType != null &&
      tees.find((tee) => tee.type === preferredType && tee.gender === gender)) ||
    (preferredType != null && tees.find((tee) => tee.type === preferredType)) ||
    (gender != null && tees.find((tee) => tee.type === "standard" && tee.gender === gender)) ||
    tees.find((tee) => tee.type === "standard") ||
    rated[0] ||
    tees[0] ||
    null
  );
}

const COURSES_PAGE_SIZE = 25;

// One course, by id — the detail page can't hunt through the paginated list.
// Nines are sorted the same way the list page sorts them.
function useCourse(courseId: string) {
  const courseQuery = useQuery(apiQuery(api.courses[":id"].$get, { param: { id: courseId } }));
  const loaded = courseQuery.data?.course;
  return {
    course: loaded ? ({ ...loaded, sets: sortNines(loaded.sets) } as CourseWithNines) : null,
    error: courseQuery.error?.message ?? null,
  };
}

export function CoursesPage() {
  const { isAdmin } = useAuth();

  const coursesQuery = useInfiniteQuery(
    apiInfiniteQuery(api.courses.$get, { query: { limit: COURSES_PAGE_SIZE } }),
  );
  // Sort the nines once here so the list's badges and the detail page's nine
  // cards agree on the order.
  const courses = pagedRecords(coursesQuery.data)?.map(
    (course) => ({ ...course, sets: sortNines(course.sets) }) as CourseWithNines,
  );
  const error = coursesQuery.error !== null ? "Unable to load courses." : null;

  return (
    <AppShell>
      <PageTitle>Courses · Scorecard</PageTitle>
      <PageHeading
        title="Courses"
        description="Every course your group plays, and its nines."
        actions={
          isAdmin ? (
            <Link to="/courses/create" className={buttonVariants({ className: "shrink-0" })}>
              <Plus data-icon="inline-start" />
              Add Course
            </Link>
          ) : undefined
        }
      />
      <section className="rounded-xl border bg-card">
        {!courses && !error && (
          <p className="p-5 text-sm text-muted-foreground">Loading courses…</p>
        )}
        {error && <p className="p-5 text-sm text-destructive">{error}</p>}
        {courses && courses.length === 0 && (
          <p className="p-5 text-sm text-muted-foreground">
            No courses yet — they'll appear once seeded or imported.
          </p>
        )}
        {courses && courses.length > 0 && (
          <ul>
            {courses.map((course) => (
              <li key={course.id} className="border-b last:border-b-0">
                <Link
                  to="/courses/$id"
                  params={{ id: course.id }}
                  className="flex flex-col gap-1 p-5 transition-colors hover:bg-muted/50"
                >
                  <p className="font-medium">{course.name}</p>
                  {course.location && (
                    <p className="text-sm text-muted-foreground">{course.location}</p>
                  )}
                  <p className="flex flex-wrap items-center gap-2">
                    {course.sets.map((set) => (
                      <Badge key={set.id} variant="secondary">
                        {set.name}
                      </Badge>
                    ))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <LoadMore
          hasMore={coursesQuery.hasNextPage}
          loading={coursesQuery.isFetchingNextPage}
          onLoadMore={() => void coursesQuery.fetchNextPage()}
        />
      </section>
    </AppShell>
  );
}

export function CourseDetailPage({ courseId }: { courseId: string }) {
  const { course, error } = useCourse(courseId);
  const { isAdmin, profile } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The signed-in golfer's tee preference, so each nine can headline the
  // rating/slope of the tee they'd actually play (the /me profile doesn't
  // carry these, so fetch the full golfer row).
  const selfQuery = useQuery({
    ...apiQuery(api.golfers[":id"].$get, { param: { id: profile?.id ?? "" } }),
    enabled: profile !== null,
  });
  const preferredType: Tee | null = selfQuery.data?.golfer.preferredTee ?? null;
  const gender = selfQuery.data?.golfer.gender ?? null;

  // Editing goes through the facility-merge path (preserves ids), so it's only
  // offered for courses linked to a USGA facility.
  const canEdit = isAdmin && course?.ncrdbFacilityId != null;

  const archiveMutation = useMutation({
    ...apiMutation(api.courses[":id"].archive.$post),
    onSuccess: async () => {
      // The archived course drops out of the registry — and out of the pickers
      // that walk every page of it.
      await queryClient.invalidateQueries({ queryKey: apiQueryKey(api.courses.$get) });
      await navigate({ to: "/courses" });
    },
  });
  const archiving = archiveMutation.isPending;

  function archiveCourse() {
    if (!course) return;
    if (
      !window.confirm(
        `Archive “${course.name}”? It'll be hidden from new scores; past outings stay intact.`,
      )
    )
      return;
    archiveMutation.mutate({ param: { id: course.id } });
  }

  return (
    <AppShell>
      <PageTitle>{course ? `${course.name} · Scorecard` : "Course · Scorecard"}</PageTitle>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm">
        <Link
          to="/courses"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          Courses
        </Link>
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">{course?.name ?? "Course"}</span>
      </nav>
      <div className="mb-8 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {course?.name ?? "Course"}
          </h1>
          {course?.location && (
            <p className="mt-1 truncate text-sm text-muted-foreground">{course.location}</p>
          )}
          {course?.ncrdbFacilityId !== null && course?.ncrdbFacilityId !== undefined && (
            <p className="mt-1 text-sm text-muted-foreground">
              {/* The NCRDB has no facility page — per-nine links below go to
                  the rated courses; this one lands on the database itself. */}
              <a
                href="https://ncrdb.usga.org/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              >
                USGA NCRDB facility {course.ncrdbFacilityId}
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </p>
          )}
        </div>
        {isAdmin && course && (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label="Course actions"
                  className="size-9 shrink-0 p-0"
                />
              }
            >
              <EllipsisVertical aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              {canEdit && (
                <Link
                  to="/courses/create"
                  search={{ facilityId: course.ncrdbFacilityId ?? undefined }}
                  className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-muted"
                >
                  <Pencil aria-hidden="true" className="size-4" />
                  Edit course
                </Link>
              )}
              <button
                type="button"
                disabled={archiving}
                onClick={archiveCourse}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                <Archive aria-hidden="true" className="size-4" />
                {archiving ? "Archiving…" : "Archive course"}
              </button>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {!course && !error && <p className="text-sm text-muted-foreground">Loading course…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {course && (
        <div className="flex flex-col gap-5">
          {course.sets.length === 0 && (
            <section className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 p-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Flag aria-hidden="true" />
              </div>
              <h2 className="mt-4 font-medium">No nines yet</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                An admin can add nines by importing a scorecard from the Courses page.
              </p>
            </section>
          )}
          {course.sets.map((set) => {
            // Group by gender first (men's, then women's, then ungendered),
            // keeping the length order within each group.
            const tees = [...sortTees(set.tees)].sort(
              (a, b) => genderOrder(a.gender) - genderOrder(b.gender),
            );
            // Hole numbers across every tee (they should agree; union so a
            // partly seeded tee can't hide columns).
            const holeNumbers = [
              ...new Set(set.tees.flatMap((tee) => tee.holes.map((hole) => hole.number))),
            ].sort((a, b) => a - b);
            // Pars can differ by tee. The Par row shows one baseline layout
            // — the men's standard tee where one exists — and each other
            // tee's deviations from it are spelled out in the tees table.
            const baseline =
              tees.find((tee) => tee.type === "standard" && tee.gender === "m") ??
              tees.find((tee) => tee.type === "standard") ??
              tees[0];
            const baselinePars = new Map(
              baseline?.holes.map((hole) => [hole.number, hole.par]) ?? [],
            );
            // The tee to headline for this golfer, and the hole layout to list
            // — its own pars where it has them, else the baseline.
            const preferred = preferredTeeFor(tees, preferredType, gender);
            const holeSource = preferred && preferred.holes.length > 0 ? preferred : baseline;
            const holeParByNumber = new Map(
              holeSource?.holes.map((hole) => [hole.number, hole.par]) ?? [],
            );
            const holeYardageByNumber = new Map(
              holeSource?.holes.map((hole) => [hole.number, hole.yardage]) ?? [],
            );
            const setPar = holeNumbers.reduce(
              (sum, number) => sum + (holeParByNumber.get(number) ?? baselinePars.get(number) ?? 0),
              0,
            );
            return (
              <section key={set.id} className="rounded-xl border bg-card">
                <div className="flex items-start justify-between gap-3 border-b p-5">
                  <div className="min-w-0">
                    <h2 className="font-medium">{set.name}</h2>
                    {set.usgaCourseId !== null && (
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        <a
                          href={`https://ncrdb.usga.org/courseTeeInfo?CourseID=${set.usgaCourseId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                        >
                          {set.usgaCourseNine !== null
                            ? `${set.usgaCourseNine === "front" ? "Front" : "Back"} 9 of USGA ${set.usgaCourseId}`
                            : `USGA ${set.usgaCourseId}`}
                          <ExternalLink aria-hidden="true" className="size-3.5" />
                        </a>
                      </p>
                    )}
                  </div>
                  <Badge variant="secondary">{nineLabel(holeNumbers)}</Badge>
                </div>

                {/* Above the fold: the rating/slope of the tee this golfer
                    would play, plus par. Full per-tee ratings live in the
                    accordion below. */}
                <dl className="flex flex-wrap gap-x-8 gap-y-3 border-b p-5">
                  <div className="min-w-0">
                    <dt className="text-xs font-medium text-muted-foreground">Your tee</dt>
                    <dd className="mt-0.5 font-medium">
                      {preferred ? (
                        <>
                          {teeLabel(preferred)}
                          {preferred.type !== null && (
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                              {TEE_LABELS[preferred.type]}
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">Rating</dt>
                    <dd className="mt-0.5 font-medium tabular-nums">
                      {preferred?.courseRating != null
                        ? preferred.courseRating.toFixed(1)
                        : "Unrated"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">Slope</dt>
                    <dd className="mt-0.5 font-medium tabular-nums">
                      {preferred?.slopeRating != null ? preferred.slopeRating : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">Par</dt>
                    <dd className="mt-0.5 font-medium tabular-nums">{setPar || "—"}</dd>
                  </div>
                </dl>

                {/* The focus: holes and pars, each linking to its stats. */}
                <ul>
                  {holeNumbers.map((number) => (
                    <li key={number} className="border-b last:border-b-0">
                      <Link
                        to="/sets/$setId/holes/$number"
                        params={{ setId: set.id, number: String(number) }}
                        className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
                      >
                        <span className="flex items-baseline gap-4">
                          <span className="w-16 text-sm font-medium">Hole {number}</span>
                          <span className="text-sm text-muted-foreground tabular-nums">
                            Par {holeParByNumber.get(number) ?? baselinePars.get(number) ?? "–"}
                            {holeYardageByNumber.get(number) != null &&
                              ` · ${holeYardageByNumber.get(number)} yds`}
                          </span>
                        </span>
                        <span className="flex items-center gap-1 text-sm text-muted-foreground">
                          <BarChart3 aria-hidden="true" className="size-4" />
                          <span className="hidden sm:inline">Statistics</span>
                          <ChevronRight aria-hidden="true" className="size-4" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>

                {/* Below the fold: every tee's ratings, slopes, and per-tee
                    par deviations. */}
                {tees.length > 0 && (
                  <details className="group border-t">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                      All tees &amp; ratings
                      <ChevronDown
                        aria-hidden="true"
                        className="size-4 transition-transform group-open:rotate-180"
                      />
                    </summary>
                    {/* Columns: gender (M/F, printed once per group), tee, its
                        app-level type (unlabeled), rating, slope. */}
                    <dl className="grid grid-cols-[auto_auto_auto_auto_auto] items-baseline gap-x-6 gap-y-1.5 border-t p-5 text-sm">
                      <dd aria-hidden="true" />
                      <dt className="text-xs font-medium text-muted-foreground">Tee</dt>
                      <dd aria-hidden="true" />
                      <dd className="text-xs font-medium text-muted-foreground">Rating</dd>
                      <dd className="text-xs font-medium text-muted-foreground">Slope</dd>
                      {tees.map((tee, index) => {
                        // Only the first tee of each gender group prints the label.
                        const firstOfGender = index === 0 || tees[index - 1].gender !== tee.gender;
                        return (
                          <Fragment key={tee.id}>
                            <dd className="text-xs font-medium whitespace-nowrap text-muted-foreground">
                              {firstOfGender && tee.gender !== null ? tee.gender.toUpperCase() : ""}
                            </dd>
                            <dt className="whitespace-nowrap text-muted-foreground">{tee.name}</dt>
                            <dd className="whitespace-nowrap text-xs text-muted-foreground">
                              {tee.type !== null && TEE_LABELS[tee.type]}
                            </dd>
                            <dd className="tabular-nums">
                              {tee.courseRating !== null ? tee.courseRating.toFixed(1) : "Unrated"}
                            </dd>
                            <dd className="tabular-nums text-muted-foreground">
                              {tee.slopeRating !== null ? tee.slopeRating : ""}
                            </dd>
                          </Fragment>
                        );
                      })}
                    </dl>
                  </details>
                )}
              </section>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
