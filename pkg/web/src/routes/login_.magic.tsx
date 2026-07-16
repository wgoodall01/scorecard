import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MagicLinkPage } from "@/App";

export const MagicLinkSearch = z.object({
  email: z.string().catch(""),
  code: z.string().catch(""),
});
export type MagicLinkSearchSchema = z.infer<typeof MagicLinkSearch>;

export const Route = createFileRoute("/login_/magic")({
  validateSearch: MagicLinkSearch,
  component: MagicLinkRoute,
});

function MagicLinkRoute() {
  return <MagicLinkPage {...Route.useSearch()} />;
}
