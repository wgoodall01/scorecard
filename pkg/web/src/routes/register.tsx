import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RegisterPage } from "@/App";

export const RegisterSearch = z.object({
  email: z.string().catch(""),
  returnTo: z
    .string()
    .startsWith("/")
    .refine((value) => !value.startsWith("//"))
    .catch("/"),
});
export type RegisterSearchSchema = z.infer<typeof RegisterSearch>;

export const Route = createFileRoute("/register")({
  validateSearch: RegisterSearch,
  component: RegisterRoute,
});

function RegisterRoute() {
  const { email, returnTo } = Route.useSearch();
  return <RegisterPage registeredEmail={email} returnTo={returnTo} />;
}
