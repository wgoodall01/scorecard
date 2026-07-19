import { z } from "zod";
import type { Env } from "../../env";

// Shared job-framework building blocks. Individual job modules import from
// HERE (createJobType + the schemas below), never from src/jobs/index.ts —
// index imports the jobs, so a job importing index would cycle. This module
// imports nothing from the framework, so it's always the leaf.

// Passed to every job's execute(). `report` overwrites the job row's `status`
// column with a user-visible progress update; `id` is the job id.
export interface JobContext {
  env: Env["Bindings"];
  id: string;
  report(report: { message: string } & Record<string, unknown>): Promise<void>;
}

// A job type: its `name` (the _job tag / job_type value), a zod schema for its
// ARGUMENTS (the job-specific fields of the spec), a zod schema for its RETURN
// VALUE (what execute resolves to, stored in job.result and resolved by
// JobHandle.result()), and the execute() handler. Create one with
// createJobType, usually in the job's own index.ts, and list it in
// src/jobs/index.ts's JOB_TYPES.
export interface JobType<
  Name extends string = string,
  Args extends z.ZodObject = z.ZodObject,
  Result extends z.ZodType = z.ZodType,
> {
  name: Name;
  args: Args;
  result: Result;
  execute(ctx: JobContext, args: z.output<Args>): Promise<z.output<Result>>;
}

export function createJobType<
  Name extends string,
  Args extends z.ZodObject,
  Result extends z.ZodType,
>(def: JobType<Name, Args, Result>): JobType<Name, Args, Result> {
  return def;
}

// The full spec schema persisted to job.spec: the tag, the id, and the job's
// own arguments. The queue message carries only { id }.
export function jobSpec(def: JobType) {
  return z.object({ _job: z.literal(def.name), id: z.uuid() }).extend(def.args.shape);
}

// Shape of the job row's `error` column when state='error'. message/stack/name
// are the usual fields, but a handler may attach anything else it captured, so
// the object is loose.
export const JobError = z
  .object({
    message: z.string(),
    stack: z.string().optional(),
    name: z.string().optional(),
  })
  .loose();
export type JobErrorSchema = z.infer<typeof JobError>;

// Shape of the job row's `status` column: the latest report({ message, ... })
// the handler emitted. Progress UX only — not part of the state machine — and
// loose so jobs can carry their own fields alongside message.
export const JobReport = z.object({ message: z.string() }).loose();
export type JobReportSchema = z.infer<typeof JobReport>;

// A job row's outcome as a zod mirror of the job_state_consistent check
// constraint, with the ok arm carrying this job type's result. `state`
// discriminates: queued/working → still in flight; ok → result present;
// error → error present.
export function JobOutcomeOf<T extends z.ZodType>(result: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("queued"), result: z.null(), error: z.null() }),
    z.object({ state: z.literal("working"), result: z.null(), error: z.null() }),
    z.object({ state: z.literal("ok"), result, error: z.null() }),
    z.object({ state: z.literal("error"), result: z.null(), error: JobError }),
  ]);
}
