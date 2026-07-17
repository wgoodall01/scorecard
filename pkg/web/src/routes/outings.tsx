import { createFileRoute } from "@tanstack/react-router";
import { OutingsPage } from "@/App";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/outings")({
  beforeLoad: checkAuth(),
  component: OutingsPage,
});
