import { createFileRoute } from "@tanstack/react-router";
import { AdminUserPage } from "@/App";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin_/users/$id")({
  beforeLoad: checkAuth({ admin: true }),
  component: AdminUserRoute,
});

function AdminUserRoute() {
  const { id } = Route.useParams();
  return <AdminUserPage userId={id} />;
}
