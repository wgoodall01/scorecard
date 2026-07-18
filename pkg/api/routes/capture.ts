import { Hono } from "hono";
import type { Env } from "../env";
import { uuidv7 } from "../schema";
import type { MatchedData } from "../src/agent/card_extract/agent";
import type { ExtractDataSchema } from "../src/agent/card_extract/schema";
import { requireAuth } from "./shared";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

export type CaptureStatus = "processing" | "complete" | "failed";

export type CaptureRecord = {
  email: string;
  status: CaptureStatus;
  error?: string;
};

export function captureKey(
  captureId: string,
  name: "image" | "capture.json" | "extracted.json" | "matched.json",
) {
  return `cards/${captureId}/${name}`;
}

export async function putCaptureRecord(
  env: Env["Bindings"],
  captureId: string,
  record: CaptureRecord,
) {
  await env.BUCKET.put(captureKey(captureId, "capture.json"), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
}

export const captureRoutes = new Hono<Env>()
  .post("/capture/submit", requireAuth, async (c) => {
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_BYTES)
      return c.json({ error: "Images must be 10 MB or smaller" }, 413);

    const form = await c.req.formData().catch(() => null);
    const image = form?.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/"))
      return c.json({ error: "An image file is required" }, 400);
    if (image.size > MAX_CAPTURE_BYTES)
      return c.json({ error: "Images must be 10 MB or smaller" }, 413);

    const captureId = uuidv7();
    const email = c.get("authEmail");
    await c.env.BUCKET.put(captureKey(captureId, "image"), image.stream(), {
      httpMetadata: { contentType: image.type },
    });
    await putCaptureRecord(c.env, captureId, { email, status: "processing" });
    await c.env.CAPTURE_QUEUE.send({ captureId, email });

    return c.json({ id: captureId }, 202);
  })
  .get("/capture/result", requireAuth, async (c) => {
    const captureId = c.req.query("id");
    if (!captureId) return c.json({ error: "A capture id is required" }, 400);

    const recordObject = await c.env.BUCKET.get(captureKey(captureId, "capture.json"));
    if (!recordObject) return c.json({ error: "Capture not found" }, 404);

    const record = await recordObject.json<CaptureRecord>();
    if (record.email !== c.get("authEmail")) return c.json({ error: "Capture not found" }, 404);
    if (record.status === "failed") return c.json({ error: record.error ?? "Service Error" }, 500);
    if (record.status === "processing") return c.json({ status: "processing" }, 202);

    const resultObject = await c.env.BUCKET.get(captureKey(captureId, "extracted.json"));
    if (!resultObject) return c.json({ error: "Capture result not found" }, 500);
    const matchedObject = await c.env.BUCKET.get(captureKey(captureId, "matched.json"));
    return c.json({
      extracted: await resultObject.json<ExtractDataSchema>(),
      matched: matchedObject ? await matchedObject.json<MatchedData>() : null,
    });
  })
  // The original photo behind a scorecard record, for the outing page's
  // gallery. Any signed-in league member can view it (fetched with the
  // bearer token and rendered from a blob URL — <img src> can't send auth).
  .get("/scorecards/:id/image", requireAuth, async (c) => {
    const imageObject = await c.env.BUCKET.get(captureKey(c.req.param("id"), "image"));
    if (!imageObject) return c.json({ error: "Scorecard image not found" }, 404);
    return c.body(imageObject.body, 200, {
      "Content-Type": imageObject.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    });
  });
