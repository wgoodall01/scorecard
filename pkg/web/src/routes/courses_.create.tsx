import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CourseCreatePage } from "@/pages/course-create";
import { checkAuth } from "@/lib/auth";

// `facilityId` puts the page in EDIT mode: it loads that facility's existing
// course straight into the editor (skipping capture/find/analyze). Absent = the
// fresh add-a-course flow.
const CourseCreateSearch = z.object({
  facilityId: z.coerce.number().int().optional(),
});

// Admin-only: the guard resolves /me and bounces non-admins to /courses (the
// API enforces admin on every course endpoint regardless).
export const Route = createFileRoute("/courses_/create")({
  validateSearch: (search) => CourseCreateSearch.parse(search),
  beforeLoad: checkAuth({ admin: true }),
  component: CourseCreateRoute,
});

function CourseCreateRoute() {
  const { facilityId } = Route.useSearch();
  return <CourseCreatePage editFacilityId={facilityId ?? null} />;
}
