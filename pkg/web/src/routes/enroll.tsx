import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { EnrollPage } from "@/pages/enroll";

export const EnrollSearch = z.object({
  token: z.string().catch(""),
});
export type EnrollSearchSchema = z.infer<typeof EnrollSearch>;

export const Route = createFileRoute("/enroll")({
  validateSearch: EnrollSearch,
  component: EnrollRoute,
});

function EnrollRoute() {
  const { token } = Route.useSearch();
  return <EnrollPage token={token} />;
}
