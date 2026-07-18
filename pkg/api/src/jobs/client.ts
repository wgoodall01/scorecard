import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { job, uuidv7 } from "../../schema";
import { jobSpec } from "./common";
import type { JobErrorSchema, JobReportSchema } from "./common";
import { type JobInputOf, type JobName, type JobResultOf, jobDef } from "./index";

const POLL_INTERVAL_MS = 1000;
const DEFAULT_RESULT_TIMEOUT_MS = 120_000;

// Thrown by JobHandle.result() when the job reached state='error'. Carries the
// stored error object (message/stack/...).
export class JobFailedError extends Error {
  readonly jobType: string;
  readonly jobId: string;
  readonly jobError: JobErrorSchema | null;

  constructor(jobType: string, jobId: string, jobError: JobErrorSchema | null) {
    super(jobError?.message ?? `Job ${jobType} ${jobId} failed`);
    this.name = "JobFailedError";
    this.jobType = jobType;
    this.jobId = jobId;
    this.jobError = jobError;
  }
}

// A row's lifecycle snapshot as read back from D1.
export type JobStatus = {
  state: "running" | "ok" | "error";
  status: JobReportSchema | null;
  error: JobErrorSchema | null;
};

// Submit a job: mint its id, write the `running` row (the spec validated
// against the job type's args schema), and enqueue just the id. Returns a
// handle. INTERNAL — routes/queue code call this, never the browser (the web
// polls its own HTTP endpoints).
export async function submit<N extends JobName>(
  env: Env["Bindings"],
  input: JobInputOf<N>,
): Promise<JobHandle<JobResultOf<N>>> {
  const def = jobDef(input._job);
  if (!def) throw new Error(`Unknown job type: ${String(input._job)}`);

  const id = uuidv7();
  const spec = jobSpec(def).parse({ ...input, id });
  await getDb(env.DB).insert(job).values({ id, jobType: def.name, spec, state: "running" });
  await env.JOB_QUEUE.send({ id });

  return new JobHandle<JobResultOf<N>>(env, def.name, id);
}

// A handle to an existing (or just-submitted) job. Construct directly to
// address a job by id when you already know its type.
export class JobHandle<Result = unknown> {
  private readonly env: Env["Bindings"];
  readonly jobType: string;
  readonly id: string;

  constructor(env: Env["Bindings"], jobType: string, id: string) {
    this.env = env;
    this.jobType = jobType;
    this.id = id;
  }

  // The current lifecycle snapshot, or null if the row is gone.
  async status(): Promise<JobStatus | null> {
    const row = await getDb(this.env.DB).query.job.findFirst({ where: eq(job.id, this.id) });
    if (!row) return null;
    return {
      state: row.state,
      status: (row.status as JobReportSchema | null) ?? null,
      error: (row.error as JobErrorSchema | null) ?? null,
    };
  }

  // Poll every second until the job leaves `running`, then resolve with its
  // result (state='ok') or throw JobFailedError (state='error'). Throws on
  // timeout or if the row vanishes.
  async result({ timeoutMs = DEFAULT_RESULT_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<Result> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await getDb(this.env.DB).query.job.findFirst({ where: eq(job.id, this.id) });
      if (!row) throw new Error(`Job ${this.id} not found`);
      if (row.state === "ok") return row.result as Result;
      if (row.state === "error") {
        throw new JobFailedError(this.jobType, this.id, (row.error as JobErrorSchema | null) ?? null);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Job ${this.id} did not finish within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
