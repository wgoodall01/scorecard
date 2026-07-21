import { createFileRoute } from "@tanstack/react-router";
import { HoleStatsPage } from "@/pages/hole";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/sets_/$setId/holes/$number")({
  beforeLoad: checkAuth(),
  component: HoleStatsRoute,
});

function HoleStatsRoute() {
  const { setId, number } = Route.useParams();
  return <HoleStatsPage setId={setId} number={Number(number)} />;
}
