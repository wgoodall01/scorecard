import { z } from "zod";
import { extractCardMetadata } from "../../agent/card_metadata/agent";
import { CardMetadata } from "../../agent/card_metadata/schema";
import { normalizeImage } from "../../agent/image";
import { RateLimitError } from "../../extraction_errors";
import { resolveModel } from "../../model";
import { scorecardImageKey } from "../../../routes/scorecard";
import { createJobType } from "../common";

// The vision extraction is rate-limit-prone; retry it a few times in-process
// (the queue never redelivers).
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads a captured scorecard photo from R2 and extracts the printed course
// LAYOUT (nine names, tee positions, per-tee par + yardage) via the
// card_metadata agent. The card lives at cards/<scorecardId>/image (owned by
// the scorecard route); the returned CardMetadata is stored on this job row's
// `result`, and the research_course job reads it back via the scorecard's
// extract_metadata_job_id. Part of the admin course-creation flow.
export const extractMetadata = createJobType({
  name: "extract_metadata",
  args: z.object({ scorecardId: z.uuid() }),
  result: CardMetadata,
  async execute(ctx, { scorecardId }) {
    const { env } = ctx;

    await ctx.report({ message: "Reading the scorecard layout…" });
    const imageObject = await env.BUCKET.get(scorecardImageKey(scorecardId));
    if (!imageObject) throw new Error("Scorecard image not found");
    const image = await normalizeImage(env, await imageObject.arrayBuffer());

    for (let attempt = 1; ; attempt++) {
      try {
        return await extractCardMetadata({ image, resolver: (spec) => resolveModel(env, spec) });
      } catch (error) {
        if (error instanceof RateLimitError && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
          await ctx.report({ message: "Busy — retrying in a moment…" });
          await sleep(RATE_LIMIT_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }
  },
});
