import { useEffect, useRef, useState } from "react";
import type { PlayerBoxSchema } from "api";
import { cn } from "@/lib/utils";

const DISPLAY_HEIGHT = 36; // px — the rendered thumbnail height
const MAX_DISPLAY_WIDTH = 160; // px — cap very wide crops
const PAD = 0.12; // fraction of the box size to add as breathing room

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// A cropped thumbnail of the handwritten name/initials, cut from the captured
// photo using the extraction's normalized bounding box. Vision-model boxes are
// only approximate, so this is a disambiguation aid — it renders nothing when
// there's no usable box or the image can't be read.
export function InitialsThumbnail({
  src,
  bbox,
  className,
}: {
  src: string;
  bbox: PlayerBoxSchema;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    setOk(false);
    if (bbox.width <= 0 || bbox.height <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const naturalWidth = image.naturalWidth;
      const naturalHeight = image.naturalHeight;

      // Pad the box, then clamp back into the image.
      const padX = bbox.width * PAD;
      const padY = bbox.height * PAD;
      const left = clamp01(bbox.x - padX);
      const top = clamp01(bbox.y - padY);
      const right = clamp01(bbox.x + bbox.width + padX);
      const bottom = clamp01(bbox.y + bbox.height + padY);

      const sx = left * naturalWidth;
      const sy = top * naturalHeight;
      const sw = Math.max(1, (right - left) * naturalWidth);
      const sh = Math.max(1, (bottom - top) * naturalHeight);

      const scale = DISPLAY_HEIGHT / sh;
      const displayWidth = Math.min(MAX_DISPLAY_WIDTH, Math.round(sw * scale));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(displayWidth * dpr);
      canvas.height = Math.round(DISPLAY_HEIGHT * dpr);
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${DISPLAY_HEIGHT}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(dpr, dpr);
      context.drawImage(image, sx, sy, sw, sh, 0, 0, displayWidth, DISPLAY_HEIGHT);
      setOk(true);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, bbox.x, bbox.y, bbox.width, bbox.height]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        "shrink-0 rounded border bg-muted",
        ok ? "opacity-100" : "opacity-0",
        className,
      )}
      style={{ height: DISPLAY_HEIGHT }}
    />
  );
}
