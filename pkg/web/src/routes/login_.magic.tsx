import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MagicLinkPage } from "@/pages/login";

export const MagicLinkSearch = z.object({
  email: z.string().catch(""),
  // TanStack Router JSON-parses search values. A code such as `123456` therefore
  // arrives here as a number; coerce it back before passing it to the auth API.
  code: z.coerce
    .string()
    .regex(/^\d{6}$/)
    .catch(""),
});
export type MagicLinkSearchSchema = z.infer<typeof MagicLinkSearch>;

export const Route = createFileRoute("/login_/magic")({
  validateSearch: MagicLinkSearch,
  component: MagicLinkRoute,
});

function MagicLinkRoute() {
  return <MagicLinkPage {...Route.useSearch()} />;
}
