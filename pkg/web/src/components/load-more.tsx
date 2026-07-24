import { ChevronDown } from "lucide-react";

// The footer of a paginated card list: a full-width row that pulls the next page
// in place (matching the "Show more" row on the Me page). Wire it to an infinite
// query's `hasNextPage` / `isFetchingNextPage` / `fetchNextPage`. It renders
// nothing once the list is exhausted, so it can sit unconditionally at the end
// of a card.
export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
  label = "Load more",
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  label?: string;
}) {
  if (!hasMore) return null;
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onLoadMore}
      className="flex w-full items-center justify-center gap-1 border-t p-3 text-sm font-medium transition-colors hover:bg-muted/50 disabled:opacity-50"
    >
      {loading ? "Loading…" : label}
      <ChevronDown aria-hidden="true" className="size-4" />
    </button>
  );
}
