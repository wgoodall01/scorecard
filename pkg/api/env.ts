export type Env = {
  Bindings: {
    DB: D1Database;
    BUCKET: R2Bucket;
    ASSETS: Fetcher;
    AUTH_CODES: KVNamespace;
    AUTH_RATE_LIMITER: RateLimit;
    EMAIL: SendEmail;
    AUTH_EMAIL_FROM: string;
    JWT_SECRET: string;
  };
  Variables: {
    authEmail: string;
  };
};
