import { createFileRoute } from "@tanstack/react-router";
import { HonorsPage } from "@/pages/honors";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/honors")({
  beforeLoad: checkAuth(),
  component: HonorsPage,
});
