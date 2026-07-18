import { createFileRoute } from "@tanstack/react-router";
import { CapturePage } from "@/pages/capture";
import { checkAuth } from "@/lib/auth";

export const Route = createFileRoute("/capture")({
  beforeLoad: checkAuth(),
  component: CapturePage,
});
