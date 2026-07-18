import { createFileRoute } from "@tanstack/react-router";
import { CourseDetailPage } from "@/pages/courses";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/courses_/$id")({
  beforeLoad: checkAuth(),
  component: CourseDetailRoute,
});

function CourseDetailRoute() {
  const { id } = Route.useParams();
  return <CourseDetailPage courseId={id} />;
}
