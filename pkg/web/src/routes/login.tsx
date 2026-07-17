import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { LoginPage } from "@/App";
import { safeReturnTo } from "@/lib/auth";

export const LoginSearch = z.object({
  returnTo: z.string().catch("/").transform(safeReturnTo),
  email: z.string().optional(),
});
export type LoginSearchSchema = z.infer<typeof LoginSearch>;

export const Route = createFileRoute("/login")({
  validateSearch: LoginSearch,
  component: LoginRoute,
});

function LoginRoute() {
  const { returnTo, email } = Route.useSearch();
  return <LoginPage returnTo={returnTo} initialEmail={email} />;
}
