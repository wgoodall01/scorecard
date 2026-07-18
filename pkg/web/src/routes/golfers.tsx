import { createFileRoute } from "@tanstack/react-router";
import { GolfersPage } from "@/pages/golfers";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/golfers")({
  beforeLoad: checkAuth(),
  component: GolfersPage,
});
