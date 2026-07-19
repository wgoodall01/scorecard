import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { job, score, scorecard, uuidv7 } from "../schema";
import type { CardMetadataSchema } from "../src/agent/card_metadata/schema";
import type { ScoresExtractData } from "../src/agent/card_scores/schema";
import type { JobErrorSchema, JobReportSchema } from "../src/jobs/common";
import { submit } from "../src/jobs/client";
import { getCurrentUser, requireAuth, zodQuery } from "./shared";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

// R2 holds ONLY the original photo; the extraction result lives on the
// extract_score job row (job.result), reached via scorecard.extractScoreJobId.
export function scorecardImageKey(scorecardId: string) {
  return `cards/${scorecardId}/image`;
}

// The `extract` multipart field of POST /scorecard: which extraction agents
// to run on the upload. `scores` reads the handwritten round (poll
// /scorecard/:id/scores); `metadata` reads the printed course layout — nine
// names, tees, pars, yardages (poll /scorecard/:id/metadata). One upload can
// request both; the admin course-creation flow uses `metadata`.
export const ScorecardExtractRequest = z.object({
  scores: z.boolean().optional().default(false),
  metadata: z.boolean().optional().default(false),
});
export type ScorecardExtractRequestSchema = z.infer<typeof ScorecardExtractRequest>;

export type ScorecardStatus = "pending" | "complete" | "failed";

// The extract_score job's lifecycle projected onto the scorecard's status:
// queued/working (or no job yet) → pending, ok → complete, error → failed.
function statusFromJobState(
  state: "queued" | "working" | "ok" | "error" | undefined,
): ScorecardStatus {
  if (state === "ok") return "complete";
  if (state === "error") return "failed";
  return "pending";
}

// The user-facing message for a failed extraction, preserving the old
// scoresError phrasing (extraction_errors sets the error names).
function scorecardErrorMessage(error: JobErrorSchema | null): string {
  if (error?.name === "ScorecardReadError") return `Couldn't read the scorecard: ${error.message}`;
  return "Service Error";
}

export const scorecardRoutes = new Hono<Env>()
  // Upload a scorecard photo. The image goes to R2, the row (tagged with the
  // uploading user) goes to the database, and each requested extraction is
  // submitted as a job (its id recorded on the row). Poll
  // GET /scorecard/:id/scores for the scores result.
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
    const authUser = await getCurrentUser(c);
    if (!authUser) return c.json({ error: "Unauthorized" }, 401);

    const scorecardId = uuidv7();
    await c.env.BUCKET.put(scorecardImageKey(scorecardId), image.stream(), {
      httpMetadata: { contentType: image.type },
    });

    // Submit the extraction jobs first so their rows exist before the
    // scorecard's foreign keys point at them.
    let extractScoreJobId: string | null = null;
    if (extract.scores) {
      const handle = await submit(c.env, { _job: "extract_score", scorecardId });
      extractScoreJobId = handle.id;
    }
    let extractMetadataJobId: string | null = null;
    if (extract.metadata) {
      const handle = await submit(c.env, { _job: "extract_metadata", scorecardId });
      extractMetadataJobId = handle.id;
    }
    await db
      .insert(scorecard)
      .values({ id: scorecardId, userId: authUser.id, extractScoreJobId, extractMetadataJobId });

    return c.json({ id: scorecardId }, 202);
  })
  // The signed-in user's scorecards, newest first. A plain thumbnail gallery —
  // no extraction status here (that's a detail-page concern, read from the
  // job row) so the list stays one D1 query with no per-row job lookups.
  .get(
    "/scorecard",
    requireAuth,
    zodQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
      "Invalid scorecard filters",
    ),
    async (c) => {
      const db = getDb(c.env.DB);
      const authUser = await getCurrentUser(c);
      if (!authUser) return c.json({ error: "Unauthorized" }, 401);

      const rows = await db.query.scorecard.findMany({
        where: eq(scorecard.userId, authUser.id),
        orderBy: [desc(scorecard.createdAt), desc(scorecard.id)],
        limit: c.req.valid("query").limit,
      });
      return c.json({
        scorecards: rows.map((row) => ({ id: row.id, createdAt: row.createdAt })),
      });
    },
  )
  // One scorecard with the outings its scores landed in. League-visible,
  // like the photo itself (outing pages show other members' cards). Status
  // and any error come from the extract_score job row.
  .get("/scorecard/:id", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const row = await db.query.scorecard.findFirst({
      where: eq(scorecard.id, c.req.param("id")),
      with: {
        user: { columns: { id: true, name: true, email: true } },
        extractScoreJob: true,
      },
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

    const jobRow = row.extractScoreJob;
    return c.json({
      scorecard: {
        id: row.id,
        createdAt: row.createdAt,
        status: statusFromJobState(jobRow?.state),
        error:
          jobRow?.state === "error"
            ? scorecardErrorMessage((jobRow.error as JobErrorSchema | null) ?? null)
            : null,
        uploader: row.user,
        outings: [...outings.values()].sort(
          (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
        ),
      },
    });
  })
  // Status/result of the scores extraction. Owner-only, mirroring the old
  // contract: 202 while pending, the result when complete, 500 with the
  // message when the extraction failed.
  .get("/scorecard/:id/scores", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const authUser = await getCurrentUser(c);
    const row = await db.query.scorecard.findFirst({
      where: eq(scorecard.id, c.req.param("id")),
    });
    if (!row || !authUser || row.userId !== authUser.id) {
      return c.json({ error: "Scorecard not found" }, 404);
    }
    if (!row.extractScoreJobId) {
      return c.json({ status: "pending" as const, message: null }, 202);
    }

    const jobRow = await db.query.job.findFirst({ where: eq(job.id, row.extractScoreJobId) });
    if (!jobRow || jobRow.state === "queued" || jobRow.state === "working") {
      const report = (jobRow?.status as JobReportSchema | null) ?? null;
      return c.json({ status: "pending" as const, message: report?.message ?? null }, 202);
    }
    if (jobRow.state === "error") {
      return c.json(
        { error: scorecardErrorMessage((jobRow.error as JobErrorSchema | null) ?? null) },
        500,
      );
    }
    return c.json(jobRow.result as ScoresExtractData);
  })
  // Status/result of the course-layout (metadata) extraction — same contract
  // as /scores. Owner-only; the admin course-creation flow polls this while
  // the admin searches for the facility.
  .get("/scorecard/:id/metadata", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const authUser = await getCurrentUser(c);
    const row = await db.query.scorecard.findFirst({
      where: eq(scorecard.id, c.req.param("id")),
    });
    if (!row || !authUser || row.userId !== authUser.id) {
      return c.json({ error: "Scorecard not found" }, 404);
    }
    if (!row.extractMetadataJobId) {
      return c.json({ status: "pending" as const, message: null }, 202);
    }

    const jobRow = await db.query.job.findFirst({ where: eq(job.id, row.extractMetadataJobId) });
    if (!jobRow || jobRow.state === "queued" || jobRow.state === "working") {
      const report = (jobRow?.status as JobReportSchema | null) ?? null;
      return c.json({ status: "pending" as const, message: report?.message ?? null }, 202);
    }
    if (jobRow.state === "error") {
      return c.json(
        { error: scorecardErrorMessage((jobRow.error as JobErrorSchema | null) ?? null) },
        500,
      );
    }
    return c.json(jobRow.result as CardMetadataSchema);
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
