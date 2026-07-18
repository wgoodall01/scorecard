// The queue carries only the job id; the consumer loads the job row (spec,
// job_type, state) from D1 and dispatches on it. See src/jobs.
export type JobQueueMessage = {
  id: string;
};

export type Env = {
  Bindings: {
    DB: D1Database;
    BUCKET: R2Bucket;
    ASSETS: Fetcher;
    AUTH_CODES: KVNamespace;
    AUTH_RATE_LIMITER: RateLimit;
    EMAIL: SendEmail;
    JOB_QUEUE: Queue<JobQueueMessage>;
    AI: Ai;
    IMAGES: ImagesBinding;
    AI_GATEWAY_ID: string;
    AUTH_EMAIL_FROM: string;
    JWT_SECRET: string;
  };
  Variables: {
    authEmail: string;
  };
};

type Bindings = Env["Bindings"];

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
