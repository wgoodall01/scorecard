import { createFileRoute } from "@tanstack/react-router";
import { MePage } from "@/App";
import { beforeLoadCheckAuth } from "@/lib/auth";

export const Route = createFileRoute("/me")({
  beforeLoad: beforeLoadCheckAuth,
  component: MePage,
});
