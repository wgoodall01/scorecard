import { createFileRoute } from "@tanstack/react-router";
import { OutingsPage } from "@/App";
import { beforeLoadCheckAuth } from "@/lib/auth";

export const Route = createFileRoute("/outings")({
  beforeLoad: beforeLoadCheckAuth,
  component: OutingsPage,
});
