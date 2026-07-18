import { Fragment, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ExternalLink, Flag } from "lucide-react";
import type { Tee } from "api";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";
import { TEE_LABELS, TEES } from "@/lib/tees";
import { dispositionLabel } from "@/pages/outings";

export type CourseWithNines = {
  id: string;
  name: string;
  location: string | null;
  ncrdbFacilityId: number | null;
  sets: {
    id: string;
    name: string;
    disposition: "front" | "back" | null;
    ncrdbCourseId: number | null;
    holes: { id: string; number: number; name: string | null; par: number }[];
    ratings: { id: string; tee: Tee; courseRating: number; slopeRating: number }[];
  }[];
};

function useCourses() {
  const { client } = useAuth();
  const [courses, setCourses] = useState<CourseWithNines[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.api.courses.$get().then(
      async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError("Unable to load courses.");
          return;
        }
        setCourses((await response.json()).courses);
      },
      () => {
        if (!cancelled) setError("Unable to load courses.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  return { courses, error };
}

export function CoursesPage() {
  const { courses, error } = useCourses();

  return (
    <AppShell>
      <PageTitle>Courses · Scorecard</PageTitle>
      <PageHeading title="Courses" description="Every course your group plays, and its nines." />
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
      </section>
    </AppShell>
  );
}

export function CourseDetailPage({ courseId }: { courseId: string }) {
  const { courses, error } = useCourses();
  const course = courses?.find((entry) => entry.id === courseId) ?? null;

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
      <div className="mb-8 min-w-0">
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
      {!courses && !error && <p className="text-sm text-muted-foreground">Loading course…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {courses && !course && (
        <p className="text-sm text-destructive">This course could not be found.</p>
      )}
      {course && (
        <div className="flex flex-col gap-5">
          {course.sets.length === 0 && (
            <section className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 p-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Flag aria-hidden="true" />
              </div>
              <h2 className="mt-4 font-medium">No nines yet</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Importing nines from a scorecard is coming soon.
              </p>
            </section>
          )}
          {course.sets.map((set) => {
            const holes = [...set.holes].sort((a, b) => a.number - b.number);
            // Present tees longest-first, in the app's canonical order.
            const ratings = [...set.ratings].sort(
              (a, b) => TEES.indexOf(a.tee) - TEES.indexOf(b.tee),
            );
            return (
              <section key={set.id} className="rounded-xl border bg-card">
                <div className="flex items-start justify-between gap-3 border-b p-5">
                  <div className="min-w-0">
                    <h2 className="font-medium">{set.name}</h2>
                    {set.ncrdbCourseId !== null && (
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        <a
                          href={`https://ncrdb.usga.org/courseTeeInfo?CourseID=${set.ncrdbCourseId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                        >
                          USGA {set.ncrdbCourseId}
                          <ExternalLink aria-hidden="true" className="size-3.5" />
                        </a>
                      </p>
                    )}
                  </div>
                  <Badge variant="secondary">{dispositionLabel(set.disposition)}</Badge>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="p-3 pl-5 font-medium">Hole</th>
                        {holes.map((hole) => (
                          <th key={hole.id} className="p-3 text-center font-medium">
                            {hole.number}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t">
                        <td className="p-3 pl-5 font-medium">Par</td>
                        {holes.map((hole) => (
                          <td key={hole.id} className="p-3 text-center tabular-nums">
                            {hole.par}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                {ratings.length > 0 && (
                  <dl className="grid grid-cols-[7rem_1fr] items-baseline gap-x-4 gap-y-1.5 border-t p-5 text-sm">
                    <dt className="text-xs font-medium text-muted-foreground">Tee</dt>
                    <dd className="text-xs font-medium text-muted-foreground">Rating / Slope</dd>
                    {ratings.map((rating) => (
                      <Fragment key={rating.id}>
                        <dt className="text-muted-foreground">{TEE_LABELS[rating.tee]}</dt>
                        <dd className="tabular-nums">
                          {rating.courseRating.toFixed(1)} / {rating.slopeRating}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
              </section>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
