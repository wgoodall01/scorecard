import { createFileRoute } from "@tanstack/react-router";
import { MePage } from "@/App";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/me")({
  beforeLoad: checkAuth(),
  component: MePage,
});
