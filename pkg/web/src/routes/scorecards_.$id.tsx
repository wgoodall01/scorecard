import { createFileRoute } from "@tanstack/react-router";
import { ScorecardDetailPage } from "@/pages/scorecards";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/scorecards_/$id")({
  beforeLoad: checkAuth(),
  component: ScorecardDetailRoute,
});

function ScorecardDetailRoute() {
  const { id } = Route.useParams();
  return <ScorecardDetailPage scorecardId={id} />;
}
