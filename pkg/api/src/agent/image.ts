import type { Env } from "../../env";

// Mirrors pkg/web/src/lib/image_resize.ts's resizeImageForCapture (2048px long
// edge, JPEG q80), applied server-side so extraction quality never depends on
// the client having resized. info() short-circuits images that already conform
// (everything the web FE uploads) through untouched — `fit: "scale-down"`
// alone wouldn't do that, since output() re-encodes even when no resize
// happens.
//
// Shared by every vision agent that reads a card image (card_scores,
// card_metadata) and the jobs that drive them.
const MAX_IMAGE_DIMENSION = 2048;
const IMAGE_JPEG_QUALITY = 80;

export async function normalizeImage(
  env: Env["Bindings"],
  buf: ArrayBuffer,
): Promise<{ buf: ArrayBuffer; contentType: string }> {
  const info = await env.IMAGES.info(new Blob([buf]).stream());
  if (
    "width" in info &&
    info.format === "image/jpeg" &&
    info.width <= MAX_IMAGE_DIMENSION &&
    info.height <= MAX_IMAGE_DIMENSION
  ) {
    return { buf, contentType: info.format };
  }

  const transformed = await env.IMAGES.input(new Blob([buf]).stream())
    .transform({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: IMAGE_JPEG_QUALITY });
  return {
    buf: await transformed.response().arrayBuffer(),
    contentType: transformed.contentType(),
  };
}

const CROP_PADDING = 0.18; // fraction of the box size added around it

// Crops a normalized-coordinate box (x/y/width/height as 0–1 fractions, from
// the top-left) out of an image via the IMAGES binding's per-side pixel trim,
// padded a little for context. Returns a JPEG crop, or null when the box is
// degenerate or the image can't be measured — cropping is best-effort (a
// disambiguation aid), never load-bearing.
export async function cropRegion(
  env: Env["Bindings"],
  buf: ArrayBuffer,
  bbox: { x: number; y: number; width: number; height: number },
): Promise<{ buf: ArrayBuffer; contentType: string } | null> {
  if (bbox.width <= 0 || bbox.height <= 0) return null;
  const info = await env.IMAGES.info(new Blob([buf]).stream());
  if (!("width" in info)) return null;

  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const padX = bbox.width * CROP_PADDING;
  const padY = bbox.height * CROP_PADDING;
  const left = clamp01(bbox.x - padX);
  const top = clamp01(bbox.y - padY);
  const right = clamp01(bbox.x + bbox.width + padX);
  const bottom = clamp01(bbox.y + bbox.height + padY);

  const trim = {
    left: Math.round(left * info.width),
    top: Math.round(top * info.height),
    right: Math.round((1 - right) * info.width),
    bottom: Math.round((1 - bottom) * info.height),
  };
  // A crop that would remove an entire axis is unusable — skip it.
  if (trim.left + trim.right >= info.width || trim.top + trim.bottom >= info.height) return null;

  const cropped = await env.IMAGES.input(new Blob([buf]).stream())
    .transform({ trim })
    .output({ format: "image/jpeg", quality: IMAGE_JPEG_QUALITY });
  return { buf: await cropped.response().arrayBuffer(), contentType: cropped.contentType() };
}
