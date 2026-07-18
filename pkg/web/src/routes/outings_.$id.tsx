import { createFileRoute } from "@tanstack/react-router";
import { OutingDetailPage } from "@/pages/outings";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/outings_/$id")({
  beforeLoad: checkAuth(),
  component: OutingDetailRoute,
});

function OutingDetailRoute() {
  const { id } = Route.useParams();
  return <OutingDetailPage outingId={id} />;
}
