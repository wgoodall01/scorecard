import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HonorsPage } from "@/pages/honors";
import { checkAuth } from "@/lib/auth";

const NaiveDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

// Absent params mean "the current calendar year" (the page fills the
// defaults), so plain /honors keeps a clean URL.
export const HonorsSearch = z.object({
  from: NaiveDate,
  to: NaiveDate,
});
export type HonorsSearchSchema = z.infer<typeof HonorsSearch>;

export const Route = createFileRoute("/honors")({
  beforeLoad: checkAuth(),
  validateSearch: HonorsSearch,
  component: HonorsRoute,
});

function HonorsRoute() {
  const { from, to } = Route.useSearch();
  return <HonorsPage from={from} to={to} />;
}
