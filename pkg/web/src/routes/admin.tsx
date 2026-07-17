import { createFileRoute } from "@tanstack/react-router";
import { AdminPage } from "@/App";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin")({
  beforeLoad: checkAuth({ admin: true }),
  component: AdminPage,
});
