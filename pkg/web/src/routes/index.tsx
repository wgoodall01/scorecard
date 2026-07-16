import { createFileRoute } from "@tanstack/react-router";
import { CapturePage } from "@/App";
import { beforeLoadCheckAuth } from "@/lib/auth";

export const Route = createFileRoute("/")({
  beforeLoad: beforeLoadCheckAuth,
  component: CapturePage,
});
