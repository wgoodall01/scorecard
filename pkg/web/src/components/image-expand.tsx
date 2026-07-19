import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { cn } from "@/lib/utils";

// An image that opens a full-screen lightbox when tapped. Inside, the image
// pinch-zooms (touch), wheel-zooms and double-taps to toggle (desktop), and
// pans when zoomed — all via react-zoom-pan-pinch, which transforms only the
// image, so the overlay and the corner close button stay put. Used for every
// scorecard photo.
export function ImageExpand({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <>
      <img
        src={src}
        alt={alt}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cn("cursor-zoom-in", className)}
      />
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            className="fixed inset-0 z-50 bg-black/90"
          >
            <TransformWrapper
              minScale={1}
              maxScale={6}
              doubleClick={{ mode: "toggle", step: 1.4 }}
              wheel={{ step: 0.2 }}
              pinch={{ step: 5 }}
              centerZoomedOut
            >
              <TransformComponent
                wrapperStyle={{ width: "100%", height: "100%" }}
                contentStyle={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <img
                  src={src}
                  alt={alt}
                  draggable={false}
                  className="max-h-[100dvh] max-w-[100vw] object-contain select-none"
                />
              </TransformComponent>
            </TransformWrapper>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-10 flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
            >
              <X aria-hidden="true" />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
