import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HonorsPage } from "@/pages/honors";
import { checkAuth } from "@/lib/auth";

const NaiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Absent params mean "the current year" (resolved in HonorsPage so the
// default URL stays clean); malformed dates fall back the same way.
export const HonorsSearch = z.object({
  since: NaiveDate.optional().catch(undefined),
  until: NaiveDate.optional().catch(undefined),
});
export type HonorsSearchSchema = z.infer<typeof HonorsSearch>;

export const Route = createFileRoute("/honors")({
  validateSearch: HonorsSearch,
  beforeLoad: checkAuth(),
  component: HonorsRoute,
});

function HonorsRoute() {
  const { since, until } = Route.useSearch();
  return <HonorsPage since={since} until={until} />;
}
