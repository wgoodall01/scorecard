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
