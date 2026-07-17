import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

export type ScorecardFixture = {
  label: string;
  contentType: string;
  bytes: ArrayBuffer;
  // Parsed extracted.json when the fixture has a reviewed label; null for
  // fixtures that haven't been labeled yet.
  expected: unknown | null;
};

// Mirrors pkg/web/src/lib/image_resize.ts's resizeImageForCapture exactly, so
// fixtures can be committed as high-res originals and the eval still sees
// what production would actually upload: capped at a 2048px long edge and
// always re-encoded as JPEG at quality 80, even if already smaller.
const MAX_IMAGE_DIMENSION = 2048;
const JPEG_QUALITY = 80;

async function resizeForCapture(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .rotate() // normalize EXIF orientation, matching createImageBitmap's default
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

export async function loadFixtures(scorecardDir: string): Promise<ScorecardFixture[]> {
  let labels: string[];
  try {
    labels = readdirSync(scorecardDir).filter((name) =>
      statSync(join(scorecardDir, name)).isDirectory(),
    );
  } catch {
    return [];
  }

  const fixtures = await Promise.all(
    labels.sort().map(async (label): Promise<ScorecardFixture | null> => {
      const dir = join(scorecardDir, label);
      const imageFile = readdirSync(dir).find((name) => name.startsWith("image."));
      const extension = imageFile?.split(".").pop();
      if (!imageFile || !extension || !IMAGE_EXTENSIONS.has(extension)) {
        console.warn(`Skipping eval fixture "${label}": no image.{jpg,jpeg,png,webp} found`);
        return null;
      }

      let expected: unknown | null = null;
      try {
        expected = JSON.parse(readFileSync(join(dir, "extracted.json"), "utf-8"));
      } catch {
        // unlabeled fixture — still runnable, just not comparable
      }

      const original = readFileSync(join(dir, imageFile));
      const resized = await resizeForCapture(original);
      const bytes = resized.buffer.slice(
        resized.byteOffset,
        resized.byteOffset + resized.byteLength,
      ) as ArrayBuffer;
      return { label, contentType: "image/jpeg", bytes, expected };
    }),
  );

  return fixtures.filter((fixture) => fixture !== null);
}
