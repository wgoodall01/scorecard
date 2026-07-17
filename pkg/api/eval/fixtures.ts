import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { MODEL_MATRIX, type ModelSpec } from "../src/model_settings";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

export type ScorecardFixture = {
  label: string;
  contentType: string;
  bytes: ArrayBuffer;
  expected: unknown;
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
    labels.map(async (label): Promise<ScorecardFixture | null> => {
      const dir = join(scorecardDir, label);
      const imageFile = readdirSync(dir).find((name) => name.startsWith("image."));
      const extension = imageFile?.split(".").pop();
      if (!imageFile || !extension || !IMAGE_EXTENSIONS.has(extension)) {
        console.warn(`Skipping eval fixture "${label}": no image.{jpg,jpeg,png,webp} found`);
        return null;
      }

      let expected: unknown;
      try {
        expected = JSON.parse(readFileSync(join(dir, "extracted.json"), "utf-8"));
      } catch {
        console.warn(`Skipping eval fixture "${label}": no valid extracted.json found`);
        return null;
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

function splitEnvList(value: string | undefined) {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// `EVAL_MODELS` entries are `provider/model` or `provider/model@effort`.
function parseModelSpec(entry: string): ModelSpec {
  const at = entry.lastIndexOf("@");
  if (at === -1) return { model: entry };
  return { model: entry.slice(0, at), effort: entry.slice(at + 1) as ModelSpec["effort"] };
}

// `EVAL_MODELS=a,b@low bun eval` sweeps a matrix without touching the default
// single-model cost of a plain `bun eval`; `EVAL_MODELS=all` expands to the
// full validated matrix (MODEL_MATRIX in model_settings.ts).
export function evalModelSpecs(): ModelSpec[] {
  if (process.env.EVAL_MODELS === "all") return MODEL_MATRIX;
  return (
    splitEnvList(process.env.EVAL_MODELS)?.map(parseModelSpec) ?? [
      { model: "openai/gpt-5.4" } satisfies ModelSpec,
    ]
  );
}
