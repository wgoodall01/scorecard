import { APICallError, generateObject } from "ai";
import type { CaptureQueueMessage, Env } from "../../../env";
import { captureKey, putCaptureRecord } from "../../../routes/capture";
import { RateLimitError, ScorecardReadError } from "../../extraction_errors";
import {
  imageProviderOptionsFor,
  maxOutputTokensFor,
  type ModelResolver,
  type ModelSpec,
  providerOptionsFor,
  resolveModel,
} from "../../model";
import { ExtractData } from "./schema";

const EXTRACTION_PROMPT = `You are extracting structured data from a photo of a golf scorecard.

Only set courseName to text that is clearly the golf course's own name (e.g. in a logo, header, or letterhead). Scorecards have lots of other printed text that is NOT the course name — section labels like "Initials", "Scorer", or "Handicap"; hole names (some courses print or watermark a unique name for every hole); or nine names (e.g. "White Oak", "Blue Spruce"). None of these are the course name. If nothing on the card is clearly a course name, omit it rather than guessing.

Extract the date if it's handwritten on the card. Extract each nine that was actually played (front 9, back 9, or both) — omit nines with no scores. If a nine has its own printed or watermarked name (distinct from the course name), use that as nineName; otherwise describe it (e.g. "Front 9").

For each nine, list its players in the order their score rows appear on the card (first score row first), each as their name or initials exactly as written on that nine. Every scores/writtenTotals array in that nine is index-aligned with this players array: entry 0 belongs to players[0], entry 1 to players[1], and so on, with exactly one entry per player.

For each hole printed in a nine (never invent or pad in holes from the other nine), record its printed hole number, its par, and each player's handwritten score. Use null for a score that isn't written or isn't legible.

Record writtenTotals — the HANDWRITTEN totals only, never totals you compute yourself: each nine's writtenTotals comes from that nine's in/out subtotal column, and the top-level writtenTotals from the 18-hole total column. Use null wherever no total is written.

When a text value is unknown or not written, use null — never an empty string.

Respond with JSON matching the provided schema exactly.`;

// Chosen by the eval sweep (2026-07-17, 3 models × 3 efforts × 6 fixtures):
// best overall (0.977 mean) AND cheapest/fastest of the field, with
// near-zero score-cell errors. Higher effort bought nothing for this model,
// and the runner-up quality fallback is anthropic/claude-sonnet-5@medium.
const DEFAULT_MODEL: ModelSpec = "google/gemini-3.5-flash@low";

// TODO: accept a `lookupPlayer(query) => Player[]` tool here once the player
// registry exists, so extraction can resolve written initials to real player
// identities instead of returning raw strings.
export async function extractScorecard({
  image,
  resolver,
  model = DEFAULT_MODEL,
}: {
  image: { buf: ArrayBuffer; contentType: string };
  resolver: ModelResolver;
  model?: ModelSpec;
}) {
  try {
    const { object } = await generateObject({
      model: resolver(model),
      schema: ExtractData,
      maxOutputTokens: maxOutputTokensFor(model, 4096),
      providerOptions: providerOptionsFor(model),
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the scorecard data from this image." },
            {
              type: "image",
              image: image.buf,
              mediaType: image.contentType,
              providerOptions: imageProviderOptionsFor(model),
            },
          ],
        },
      ],
    });

    if (object.error) throw new ScorecardReadError(object.error);
    return object;
  } catch (error) {
    if (error instanceof ScorecardReadError) throw error;
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      throw new RateLimitError("Vision model rate limited");
    }
    throw error;
  }
}

const MAX_RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_RETRY_DELAY_SECONDS = 30;

// Mirrors pkg/web/src/lib/image_resize.ts's resizeImageForCapture (2048px long
// edge, JPEG q80), applied server-side so extraction quality never depends on
// the client having resized. info() short-circuits images that already conform
// (everything the web FE uploads) through untouched — `fit: "scale-down"`
// alone wouldn't do that, since output() re-encodes even when no resize
// happens.
const MAX_IMAGE_DIMENSION = 2048;
const IMAGE_JPEG_QUALITY = 80;

async function normalizeImage(
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

async function extractCapture(env: Env["Bindings"], captureId: string, email: string) {
  const imageObject = await env.BUCKET.get(captureKey(captureId, "image"));
  if (!imageObject) throw new Error("Capture image not found");

  const data = await extractScorecard({
    image: await normalizeImage(env, await imageObject.arrayBuffer()),
    resolver: (spec) => resolveModel(env, spec),
  });

  await env.BUCKET.put(captureKey(captureId, "extracted.json"), JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
  });
  await putCaptureRecord(env, captureId, { email, status: "complete" });
}

export async function handleCaptureQueue(
  batch: MessageBatch<CaptureQueueMessage>,
  env: Env["Bindings"],
) {
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await extractCapture(env, message.body.captureId, message.body.email);
        message.ack();
      } catch (error) {
        console.error("Capture extraction failed", { captureId: message.body.captureId, error });

        if (error instanceof RateLimitError && message.attempts < MAX_RATE_LIMIT_ATTEMPTS) {
          message.retry({ delaySeconds: RATE_LIMIT_RETRY_DELAY_SECONDS });
          return;
        }

        await putCaptureRecord(env, message.body.captureId, {
          email: message.body.email,
          status: "failed",
          error:
            error instanceof ScorecardReadError
              ? `Couldn't read the scorecard: ${error.message}`
              : "Service Error",
        });
        message.ack();
      }
    }),
  );
}
