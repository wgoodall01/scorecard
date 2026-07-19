import { z } from "zod";
import { extractScorecard, matchCapture } from "../../agent/card_scores/agent";
import { ScoresExtractData } from "../../agent/card_scores/schema";
import { normalizeImage } from "../../agent/image";
import { RateLimitError } from "../../extraction_errors";
import { resolveModel } from "../../model";
import { scorecardImageKey } from "../../../routes/scorecard";
import { createJobType } from "../common";

// The vision extraction is rate-limit-prone; retry it a few times in-process
// (the queue never redelivers). Matching is best-effort inside matchCapture,
// so it isn't retried here.
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads the uploaded scorecard photo from R2, runs the vision extraction and
// the player/course matching agents, and returns the reviewed-capture data the
// review UI loads. The card image lives at cards/<scorecardId>/image (owned by
// the scorecard route); the returned ScoresExtractData is stored on the job
// row's `result` column, which the scorecard endpoints read via the
// scorecard's extract_score_job_id.
export const extractScore = createJobType({
  name: "extract_score",
  args: z.object({ scorecardId: z.uuid() }),
  result: ScoresExtractData,
  async execute(ctx, { scorecardId }) {
    const { env } = ctx;

    await ctx.report({ message: "Reading your scorecard…" });
    const imageObject = await env.BUCKET.get(scorecardImageKey(scorecardId));
    if (!imageObject) throw new Error("Scorecard image not found");
    const image = await normalizeImage(env, await imageObject.arrayBuffer());

    let extracted: Awaited<ReturnType<typeof extractScorecard>> | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        extracted = await extractScorecard({ image, resolver: (spec) => resolveModel(env, spec) });
        break;
      } catch (error) {
        if (error instanceof RateLimitError && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
          await ctx.report({ message: "Busy — retrying in a moment…" });
          await sleep(RATE_LIMIT_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }

    await ctx.report({ message: "Matching players and course…" });
    const matched = await matchCapture(env, extracted);

    return { extracted, matched };
  },
});
