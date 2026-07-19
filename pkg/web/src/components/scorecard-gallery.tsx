import { useEffect, useState } from "react";
import { ImageExpand } from "@/components/image-expand";
import { useAuth } from "@/lib/auth-context";

// Horizontal-scroll gallery of scorecard photo thumbnails; tapping one opens
// the zoomable lightbox. Images are fetched with the bearer token and shown
// from blob URLs (a plain <img src> can't send the Authorization header).
export function ScorecardGallery({ scorecards }: { scorecards: { id: string }[] }) {
  const { client } = useAuth();
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!client || scorecards.length === 0) return;
    let cancelled = false;
    const created: string[] = [];
    void Promise.all(
      scorecards.map(async (card) => {
        const response = await client.api.scorecard[":id"].image.$get({
          param: { id: card.id },
        });
        if (!response.ok || cancelled) return null;
        const url = URL.createObjectURL(await response.blob());
        created.push(url);
        return [card.id, url] as const;
      }),
    ).then((entries) => {
      if (!cancelled) {
        setUrls(Object.fromEntries(entries.filter((entry) => entry !== null)));
      }
    });
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [client, scorecards]);

  return (
    <div className="flex gap-3 overflow-x-auto p-5">
      {scorecards.map((card, index) =>
        urls[card.id] ? (
          <ImageExpand
            key={card.id}
            src={urls[card.id]}
            alt={`Scorecard ${index + 1}`}
            className="h-28 w-auto max-w-48 shrink-0 rounded-xl border bg-muted object-cover outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        ) : (
          <div
            key={card.id}
            className="h-28 w-40 shrink-0 animate-pulse rounded-xl border bg-muted"
          />
        ),
      )}
    </div>
  );
}
