import { createFileRoute } from "@tanstack/react-router";
import { CapturePage } from "@/App";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/")({
  beforeLoad: checkAuth(),
  component: CapturePage,
});
