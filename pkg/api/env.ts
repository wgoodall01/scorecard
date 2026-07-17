export type CaptureQueueMessage = {
  captureId: string;
  email: string;
};

export type Env = {
  Bindings: {
    DB: D1Database;
    BUCKET: R2Bucket;
    ASSETS: Fetcher;
    AUTH_CODES: KVNamespace;
    AUTH_RATE_LIMITER: RateLimit;
    EMAIL: SendEmail;
    CAPTURE_QUEUE: Queue<CaptureQueueMessage>;
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
