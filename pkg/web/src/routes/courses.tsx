import { createFileRoute } from "@tanstack/react-router";
import { CoursesPage } from "@/pages/courses";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/courses")({
  beforeLoad: checkAuth(),
  component: CoursesPage,
});
