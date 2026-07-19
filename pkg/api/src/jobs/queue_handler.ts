import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import type { Env, JobQueueMessage } from "../../env";
import { job } from "../../schema";
import type { JobContext, JobErrorSchema, JobType } from "./common";
import { jobDef } from "./index";

function toJobError(error: unknown): JobErrorSchema {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name };
  }
  return { message: String(error) };
}

const isoNow = () => new Date().toISOString();

// Load one job row, dispatch on its job_type, and drive it to a terminal
// state. Rate-limit backoff and any other retry logic live INSIDE the handler
// (per-job) — the queue never redelivers (max_retries = 0), so a job that
// throws lands in state='error' and is done.
async function runJob(env: Env["Bindings"], id: string) {
  const db = getDb(env.DB);
  const row = await db.query.job.findFirst({ where: eq(job.id, id) });
  if (!row) {
    console.error("Job row not found for queue message", { id });
    return;
  }
  // Only pick up a freshly queued job. Anything else — a working job (racing
  // duplicate delivery) or a terminal one — is left alone; never re-run
  // (extract_score would re-spend the vision call).
  if (row.state !== "queued") return;

  // Claim the job: queued → working, stamping when work began.
  await db.update(job).set({ state: "working", workingAt: isoNow() }).where(eq(job.id, id));

  // The union of job defs isn't callable as one signature; the row's job_type
  // is the runtime discriminant, so dispatch through the base JobDef shape.
  const def = jobDef(row.jobType) as JobType | undefined;
  try {
    if (!def) throw new Error(`Unknown job type: ${row.jobType}`);

    const ctx: JobContext = {
      env,
      id,
      async report(report) {
        await db.update(job).set({ status: report }).where(eq(job.id, id));
      },
    };

    // args schema strips the _job/id spec envelope, leaving the handler args.
    const args = def.args.parse(row.spec);
    const result = def.result.parse(await def.execute(ctx, args));
    await db
      .update(job)
      .set({ state: "ok", result, error: null, okAt: isoNow() })
      .where(eq(job.id, id));
  } catch (error) {
    console.error("Job failed", { id, jobType: row.jobType, error });
    await db
      .update(job)
      .set({ state: "error", result: null, error: toJobError(error), errorAt: isoNow() })
      .where(eq(job.id, id));
  }
}

// The Worker's queue handler. One job per message; always ack once the job has
// reached a terminal state (ok/error), so nothing redelivers.
export async function handleJobQueue(batch: MessageBatch<JobQueueMessage>, env: Env["Bindings"]) {
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await runJob(env, message.body.id);
      } finally {
        message.ack();
      }
    }),
  );
}
