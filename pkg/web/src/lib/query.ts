import { QueryClient, type QueryKey } from "@tanstack/react-query";
import type { ClientRequestOptions } from "hono/client";
import type { Page } from "api";
import { ApiError } from "@/lib/auth";

// TanStack Query + hono-rpc-query is THE data-fetching path in this app: no
// fetch-in-useEffect, no ad-hoc loading/error state. Pages call
// `useQuery(apiQuery(api.thing.$get, input))`, `useMutation(apiMutation(...))`,
// or `useInfiniteQuery(apiInfiniteQuery(...))` for a paginated list.
//
// The wrappers below exist for one reason: hono-rpc-query's own `queryFn`
// calls `.json()` without checking `response.ok`, so a 404 or 500 would resolve
// as data. These keep its query keys and its end-to-end typing but fetch
// through `unwrap`, which throws — putting failures in TanStack Query's `error`
// where every page already expects them.

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // One league's data, browsed a page at a time — a short staleness window
      // makes tab-switching feel instant without serving yesterday's scores.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// The success arm of a hono `ClientResponse` union, and the JSON it carries.
// A handler that doesn't name a status (`c.json(body)`) is typed with the whole
// `ContentfulStatusCode` union, so its `ok` is `boolean` rather than `true` —
// hence excluding the error arms (`ok: false`) rather than extracting `ok: true`.
type OkResponse<TResponse> = Exclude<TResponse, { ok: false }>;
type JsonOf<TResponse> =
  OkResponse<TResponse> extends { json: () => Promise<infer TData> } ? TData : never;

type AnyResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

// A hono RPC endpoint as hono-rpc-query hands it back: the original typed
// caller plus the key builder.
type Endpoint<TCall extends (args: never, options?: ClientRequestOptions) => Promise<AnyResponse>> =
  {
    call: TCall;
    queryOptions: (args: never) => { queryKey: QueryKey };
  };

type AnyEndpoint = Endpoint<(args: never, options?: ClientRequestOptions) => Promise<AnyResponse>>;

type Input<TEndpoint extends AnyEndpoint> = Parameters<TEndpoint["call"]>[0];
type Data<TEndpoint extends AnyEndpoint> = JsonOf<Awaited<ReturnType<TEndpoint["call"]>>>;

// Await a request and give back its JSON, throwing `ApiError` (with the API's
// own message where it sent one) on any non-2xx.
export async function unwrap<TResponse extends AnyResponse>(
  request: Promise<TResponse>,
): Promise<JsonOf<TResponse>> {
  const response = await request;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? "Something went wrong. Please try again.", response.status);
  }
  return (await response.json()) as JsonOf<TResponse>;
}

// Query options for a GET: `useQuery(apiQuery(api.golfers[":id"].$get, { param: { id } }))`.
// Spread it to add TanStack options — `{ ...apiQuery(...), enabled: false }`.
export function apiQuery<TEndpoint extends AnyEndpoint>(
  endpoint: TEndpoint,
  input?: Input<TEndpoint>,
) {
  return {
    queryKey: endpoint.queryOptions({ input } as never).queryKey,
    queryFn: () => unwrap(endpoint.call(input as never)) as Promise<Data<TEndpoint>>,
  };
}

// The query key a GET would use — for `invalidateQueries` after a mutation.
export function apiQueryKey<TEndpoint extends AnyEndpoint>(
  endpoint: TEndpoint,
  input?: Input<TEndpoint>,
) {
  return endpoint.queryOptions({ input } as never).queryKey;
}

// Mutation options for a POST/PATCH/DELETE:
// `useMutation(apiMutation(api.outings.$post))`, then `mutate({ json })`.
export function apiMutation<TEndpoint extends AnyEndpoint>(endpoint: TEndpoint) {
  return {
    mutationFn: (input: Input<TEndpoint>) =>
      unwrap(endpoint.call(input as never)) as Promise<Data<TEndpoint>>,
  };
}

// A paginated GET (see `pkg/api/src/pagination.ts`) as an infinite query.
// hono-rpc-query has no `infiniteQueryOptions` yet, so this assembles them from
// the same key and caller: each page is fetched with `?after=<cursor>`, and the
// response's `next` cursor is the next page param.
export function apiInfiniteQuery<
  TEndpoint extends AnyEndpoint & { call: (args: never) => Promise<AnyResponse> },
>(endpoint: TEndpoint, input: Input<TEndpoint>) {
  type TData = Data<TEndpoint>;
  return {
    queryKey: endpoint.queryOptions({ input } as never).queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      unwrap(
        endpoint.call({
          ...(input as object),
          query: { ...((input as { query?: object }).query ?? {}), after: pageParam },
        } as never),
      ) as Promise<TData>,
    // Every paginated response is a `Page`: `next` is the cursor to follow,
    // null at the end of the list.
    getNextPageParam: (lastPage: TData) => (lastPage as Page<unknown>).next ?? undefined,
  };
}

// The records of every loaded page, flattened — or null while the first page is
// still in flight (pages render a "Loading…" line on null).
export function pagedRecords<TRecord>(
  data: { pages: Page<TRecord>[] } | undefined,
): TRecord[] | null {
  return data === undefined ? null : data.pages.flatMap((page) => page.records);
}
