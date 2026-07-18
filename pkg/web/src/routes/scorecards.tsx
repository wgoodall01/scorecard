import { createFileRoute } from "@tanstack/react-router";
import { ScorecardsPage } from "@/pages/scorecards";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/scorecards")({
  beforeLoad: checkAuth(),
  component: ScorecardsPage,
});
