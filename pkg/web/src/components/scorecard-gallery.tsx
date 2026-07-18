import { useEffect, useState } from "react";
import { ResponsiveModal } from "@/components/responsive-modal";
import { useAuth } from "@/lib/auth-context";

// Horizontal-scroll gallery of scorecard photo thumbnails; tapping one opens
// it full-size. Images are fetched with the bearer token and shown from blob
// URLs (a plain <img src> can't send the Authorization header).
export function ScorecardGallery({ scorecards }: { scorecards: { id: string }[] }) {
  const { client } = useAuth();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);

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
    <>
      <div className="flex gap-3 overflow-x-auto p-5">
        {scorecards.map((card, index) => (
          <button
            key={card.id}
            type="button"
            aria-label={`View scorecard ${index + 1}`}
            className="shrink-0 rounded-xl outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => setOpenId(card.id)}
          >
            {urls[card.id] ? (
              <img
                src={urls[card.id]}
                alt={`Scorecard ${index + 1}`}
                className="h-28 w-auto max-w-48 rounded-xl border bg-muted object-cover"
              />
            ) : (
              <div className="h-28 w-40 animate-pulse rounded-xl border bg-muted" />
            )}
          </button>
        ))}
      </div>
      <ResponsiveModal
        open={openId !== null}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
        title="Scorecard photo"
        hideHeader
        contentClassName="gap-0 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:max-w-3xl sm:p-2"
      >
        {openId && urls[openId] && (
          <img
            src={urls[openId]}
            alt="Scorecard photo"
            className="max-h-[75dvh] w-full rounded-3xl object-contain"
          />
        )}
      </ResponsiveModal>
    </>
  );
}
