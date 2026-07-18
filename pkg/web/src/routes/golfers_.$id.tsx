import { createFileRoute } from "@tanstack/react-router";
import { GolferDetailPage } from "@/pages/golfers";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/golfers_/$id")({
  beforeLoad: checkAuth(),
  component: GolferDetailRoute,
});

function GolferDetailRoute() {
  const { id } = Route.useParams();
  return <GolferDetailPage golferId={id} />;
}
