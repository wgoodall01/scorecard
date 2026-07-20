import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { LoginPage } from "@/pages/login";
import { safeReturnTo } from "@/lib/auth";

export const LoginSearch = z.object({
  returnTo: z.string().catch("/").transform(safeReturnTo),
  email: z.string().optional(),
  // DEV ONLY: /login?devLoginOverride=<email> immediately mints a session as
  // that user (see LoginPage). Backed by the local-only /auth/dev-login route,
  // so it's inert in production regardless of this param.
  devLoginOverride: z.string().optional(),
});
export type LoginSearchSchema = z.infer<typeof LoginSearch>;

export const Route = createFileRoute("/login")({
  validateSearch: LoginSearch,
  component: LoginRoute,
});

function LoginRoute() {
  const { returnTo, email, devLoginOverride } = Route.useSearch();
  return <LoginPage returnTo={returnTo} initialEmail={email} devLoginOverride={devLoginOverride} />;
}
