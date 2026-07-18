import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { score, scorecard, user, uuidv7 } from "../schema";
import { requireAuth, zodQuery } from "./shared";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

// R2 holds ONLY the original photo; extraction results live on the scorecard
// row (scores_extract / scores_error).
export function scorecardImageKey(scorecardId: string) {
  return `cards/${scorecardId}/image`;
}

// The `extract` multipart field of POST /scorecard: which extraction agents
// to run on the upload. `scores` is the round extraction; a course-metadata
// (pars/yardages) extraction will join it here.
export const ScorecardExtractRequest = z.object({
  scores: z.boolean().optional().default(false),
});
export type ScorecardExtractRequestSchema = z.infer<typeof ScorecardExtractRequest>;

export type ScorecardStatus = "pending" | "complete" | "failed";

export function scorecardStatus(row: {
  scoresExtract: unknown;
  scoresError: string | null;
}): ScorecardStatus {
  if (row.scoresError !== null) return "failed";
  return row.scoresExtract != null ? "complete" : "pending";
}

async function getAuthUser(db: ReturnType<typeof getDb>, authEmail: string) {
  return await db.query.user.findFirst({ where: eq(user.email, authEmail) });
}

export const scorecardRoutes = new Hono<Env>()
  // Upload a scorecard photo. The image goes to R2, the row (tagged with the
  // uploading user) goes to the database, and each requested extraction is
  // enqueued. Poll GET /scorecard/:id/scores for the scores result.
  .post("/scorecard", requireAuth, async (c) => {
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_BYTES)
      return c.json({ error: "Images must be 10 MB or smaller" }, 413);

    const form = await c.req.formData().catch(() => null);
    const image = form?.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/"))
      return c.json({ error: "An image file is required" }, 400);
    if (image.size > MAX_CAPTURE_BYTES)
      return c.json({ error: "Images must be 10 MB or smaller" }, 413);

    const rawExtract = form?.get("extract");
    let extract: ScorecardExtractRequestSchema;
    try {
      extract = ScorecardExtractRequest.parse(
        typeof rawExtract === "string" ? JSON.parse(rawExtract) : {},
      );
    } catch {
      return c.json({ error: 'The extract field must be JSON like {"scores": true}' }, 400);
    }

    const db = getDb(c.env.DB);
    const authUser = await getAuthUser(db, c.get("authEmail"));
    if (!authUser) return c.json({ error: "Unauthorized" }, 401);

    const scorecardId = uuidv7();
    await c.env.BUCKET.put(scorecardImageKey(scorecardId), image.stream(), {
      httpMetadata: { contentType: image.type },
    });
    await db.insert(scorecard).values({ id: scorecardId, userId: authUser.id });
    if (extract.scores) {
      await c.env.CAPTURE_QUEUE.send({ scorecardId });
    }

    return c.json({ id: scorecardId }, 202);
  })
  // The signed-in user's scorecards, newest first.
  .get(
    "/scorecard",
    requireAuth,
    zodQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
      "Invalid scorecard filters",
    ),
    async (c) => {
      const db = getDb(c.env.DB);
      const authUser = await getAuthUser(db, c.get("authEmail"));
      if (!authUser) return c.json({ error: "Unauthorized" }, 401);

      const rows = await db.query.scorecard.findMany({
        where: eq(scorecard.userId, authUser.id),
        orderBy: [desc(scorecard.createdAt), desc(scorecard.id)],
        limit: c.req.valid("query").limit,
      });
      return c.json({
        scorecards: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          status: scorecardStatus(row),
        })),
      });
    },
  )
  // One scorecard with the outings its scores landed in. League-visible,
  // like the photo itself (outing pages show other members' cards).
  .get("/scorecard/:id", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const row = await db.query.scorecard.findFirst({
      where: eq(scorecard.id, c.req.param("id")),
      with: { user: { columns: { id: true, name: true, email: true } } },
    });
    if (!row) return c.json({ error: "Scorecard not found" }, 404);

    const cells = await db.query.score.findMany({
      where: eq(score.scorecardId, row.id),
      with: { scoreSet: { with: { outing: { with: { course: true } } } } },
    });
    const outings = new Map<string, { id: string; date: string; courseName: string }>();
    for (const cell of cells) {
      const found = cell.scoreSet.outing;
      outings.set(found.id, { id: found.id, date: found.date, courseName: found.course.name });
    }

    return c.json({
      scorecard: {
        id: row.id,
        createdAt: row.createdAt,
        status: scorecardStatus(row),
        error: row.scoresError,
        uploader: row.user,
        outings: [...outings.values()].sort(
          (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
        ),
      },
    });
  })
  // Status/result of the scores extraction. Owner-only, mirroring the old
  // /capture/result contract: 202 while pending, the result when complete,
  // 500 with the message when the extraction failed.
  .get("/scorecard/:id/scores", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const authUser = await getAuthUser(db, c.get("authEmail"));
    const row = await db.query.scorecard.findFirst({
      where: eq(scorecard.id, c.req.param("id")),
    });
    if (!row || !authUser || row.userId !== authUser.id) {
      return c.json({ error: "Scorecard not found" }, 404);
    }

    if (row.scoresError !== null) return c.json({ error: row.scoresError }, 500);
    if (row.scoresExtract == null) return c.json({ status: "pending" as const }, 202);
    return c.json(row.scoresExtract);
  })
  // The original photo, for the outing page's gallery and the scorecard
  // pages. Any signed-in league member can view it (fetched with the bearer
  // token and rendered from a blob URL — <img src> can't send auth).
  .get("/scorecard/:id/image", requireAuth, async (c) => {
    const imageObject = await c.env.BUCKET.get(scorecardImageKey(c.req.param("id")));
    if (!imageObject) return c.json({ error: "Scorecard image not found" }, 404);
    return c.body(imageObject.body, 200, {
      "Content-Type": imageObject.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    });
  });
