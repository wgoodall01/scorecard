import { useQuery } from "@tanstack/react-query";
import { ImageExpand } from "@/components/image-expand";
import { scorecardImageQuery } from "@/lib/queries";

// Horizontal-scroll gallery of scorecard photo thumbnails; tapping one opens
// the zoomable lightbox. Images are fetched with the bearer token and shown
// from blob URLs (a plain <img src> can't send the Authorization header).
export function ScorecardGallery({ scorecards }: { scorecards: { id: string }[] }) {
  return (
    <div className="flex gap-3 overflow-x-auto p-5">
      {scorecards.map((card, index) => (
        <GalleryThumb key={card.id} scorecardId={card.id} index={index} />
      ))}
    </div>
  );
}

// One thumbnail per card, so each photo loads (and caches) on its own.
function GalleryThumb({ scorecardId, index }: { scorecardId: string; index: number }) {
  const url = useQuery(scorecardImageQuery(scorecardId)).data;
  if (url === undefined) {
    return <div className="h-28 w-40 shrink-0 animate-pulse rounded-xl border bg-muted" />;
  }
  return (
    <ImageExpand
      src={url}
      alt={`Scorecard ${index + 1}`}
      className="h-28 w-auto max-w-48 shrink-0 rounded-xl border bg-muted object-cover outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
    />
  );
}
