import type { z } from "zod";
import { extractMetadata } from "./extract_metadata";
import { extractScore } from "./extract_score";
import { researchCourseJob } from "./research_course";

// Every job type, keyed by name. To add a job: create it with createJobType in
// its own module (importing from ./common, never from here) and add it below.
// Each value's `name` must equal its key.
export const JOB_TYPES = {
  extract_score: extractScore,
  extract_metadata: extractMetadata,
  research_course: researchCourseJob,
} as const;

export type JobTypes = typeof JOB_TYPES;
export type JobName = keyof JobTypes & string;
export type AnyJobType = JobTypes[JobName];

type ArgsOf<N extends JobName> = z.output<JobTypes[N]["args"]>;

// The handler's return value for a job type — what a JobHandle for it resolves
// to.
export type JobResultOf<N extends JobName> = z.output<JobTypes[N]["result"]>;

// What submit() accepts for a job type: the tag plus the job's arguments (no
// id — submit mints it).
export type JobInputOf<N extends JobName> = { _job: N } & ArgsOf<N>;
export type JobInput = { [N in JobName]: JobInputOf<N> }[JobName];

// The stored spec for a job type ({ _job, id, ...args }) — what lands in
// job.spec, and (as { id }) on the queue.
export type JobSpecOf<N extends JobName> = { _job: N; id: string } & ArgsOf<N>;
export type Job = { [N in JobName]: JobSpecOf<N> }[JobName];

// The declaration for a job_type value read off a row, or undefined if the
// type is unknown (e.g. a row written by a newer deploy).
export function jobDef(name: string): AnyJobType | undefined {
  return (JOB_TYPES as Record<string, AnyJobType>)[name];
}
