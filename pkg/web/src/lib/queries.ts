import { queryOptions } from "@tanstack/react-query";
import type { Page } from "api";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/auth";
import { apiQuery, apiQueryKey, unwrap } from "@/lib/query";

// Shared query factories: the things more than one page asks for, and the two
// shapes `apiQuery` can't express on its own (a walk over every page, and a
// binary response).

// The registries a picker needs in FULL: the course and golfer lists are
// paginated (newest first), but a combobox filters and sorts the whole thing
// client-side. These walk every page once and cache the flattened, name-sorted
// result under its own query key. A list PAGE should use `apiInfiniteQuery`
// instead of loading everything.

const REGISTRY_PAGE_SIZE = 200;
// A safety net: a cursor bug shouldn't be able to spin forever.
const MAX_PAGES = 25;

async function collectAll<TRecord>(
  loadPage: (after: string | undefined) => Promise<Page<TRecord>>,
): Promise<TRecord[]> {
  const records: TRecord[] = [];
  let after: string | undefined = undefined;
  for (let fetched = 0; fetched < MAX_PAGES; fetched++) {
    const page = await loadPage(after);
    records.push(...page.records);
    if (page.next === null) break;
    after = page.next;
  }
  return records;
}

export function allCoursesQuery() {
  return queryOptions({
    queryKey: [...apiQueryKey(api.courses.$get, { query: {} }), "all"],
    queryFn: async () => {
      const courses = await collectAll((after) =>
        unwrap(api.courses.$get.call({ query: { after, limit: REGISTRY_PAGE_SIZE } })),
      );
      return courses.sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

export function allGolfersQuery() {
  return queryOptions({
    queryKey: [...apiQueryKey(api.golfers.$get, { query: {} }), "all"],
    queryFn: async () => {
      const golfers = await collectAll((after) =>
        unwrap(api.golfers.$get.call({ query: { after, limit: REGISTRY_PAGE_SIZE } })),
      );
      return golfers.sort((a, b) =>
        (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""),
      );
    },
  });
}

// Both extraction endpoints (and the course-research poll) answer 202 with this
// shape while the job runs, and the finished result once it's done — so a
// response carrying `status: "pending"` means "ask again".
export type PendingJob = { status: "pending"; message: string | null };

export function isPending(data: unknown): data is PendingJob {
  return (
    typeof data === "object" && data !== null && (data as { status?: unknown }).status === "pending"
  );
}

const JOB_POLL_MS = 750;

// Poll while the job is pending, until `deadline` (epoch ms) passes — the
// caller treats a still-pending query past its deadline as a timeout. `retry:
// false` because a failed job is terminal: its error is the answer.
function jobPolling(deadline: number) {
  return {
    refetchInterval: (query: { state: { data: unknown } }) =>
      isPending(query.state.data) && Date.now() < deadline ? JOB_POLL_MS : (false as const),
    retry: false,
    staleTime: 0,
  };
}

// The handwritten-round extraction behind a capture (the capture flow's wait).
export function scorecardScoresQuery(scorecardId: string | null, deadline: number) {
  return queryOptions({
    ...apiQuery(api.scorecard[":id"].scores.$get, { param: { id: scorecardId ?? "" } }),
    ...jobPolling(deadline),
    enabled: scorecardId !== null,
  });
}

// The printed course-layout extraction (the admin course-import flow).
export function scorecardMetadataQuery(scorecardId: string | null, deadline: number) {
  return queryOptions({
    ...apiQuery(api.scorecard[":id"].metadata.$get, { param: { id: scorecardId ?? "" } }),
    ...jobPolling(deadline),
    enabled: scorecardId !== null,
  });
}

// The USGA-reconciliation job started for a scorecard + facility.
export function courseResearchQuery(jobId: string | null, deadline: number) {
  return queryOptions({
    ...apiQuery(api.courses.research[":jobId"].$get, { param: { jobId: jobId ?? "" } }),
    ...jobPolling(deadline),
    enabled: jobId !== null,
  });
}

// A scorecard photo as an object URL. The image endpoint needs the bearer token,
// so a plain `<img src>` can't fetch it — we pull the bytes and wrap them.
// Cached forever: the photo never changes, and the object URL has to outlive
// every remount that shows it (nothing revokes it, so the cost is bounded by
// the number of cards viewed in a session).
export function scorecardImageQuery(scorecardId: string) {
  return queryOptions({
    queryKey: [
      ...apiQueryKey(api.scorecard[":id"].image.$get, { param: { id: scorecardId } }),
      "objectUrl",
    ],
    queryFn: async () => {
      const response = await api.scorecard[":id"].image.$get.call({
        param: { id: scorecardId },
      });
      if (!response.ok) throw new ApiError("Unable to load this photo.", response.status);
      return URL.createObjectURL(await response.blob());
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
