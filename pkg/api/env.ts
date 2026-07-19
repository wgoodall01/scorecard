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
    AUTH_RATE_LIMITER: RateLimit;
    EMAIL: SendEmail;
    JOB_QUEUE: Queue<JobQueueMessage>;
    AI: Ai;
    IMAGES: ImagesBinding;
    AI_GATEWAY_ID: string;
    AUTH_EMAIL_FROM: string;
    JWT_SECRET: string;
    // WebAuthn: the RP's display name and the comma-separated allowlist of
    // origins passkeys may be used from. rpID/expectedOrigin are derived
    // per-request from the caller's Origin header validated against this list
    // (see src/auth/webauthn.ts), so localhost/prod/ngrok all work.
    WEBAUTHN_RP_NAME: string;
    WEBAUTHN_ALLOWED_ORIGINS: string;
    // Signs the short-lived WebAuthn challenge JWT. A dedicated secret,
    // separate from JWT_SECRET, so session tokens and challenge tokens can't
    // be cross-forged.
    AUTHN_CHALLENGE_SIGNING_SECRET: string;
  };
  Variables: {
    // The signed-in user's id (the session JWT's `sub`).
    authUserId: string;
    // The passkey that minted this session (JWT `cred`), or null if the token
    // predates the claim. Set by requireAuth.
    authCredentialId: string | null;
  };
};

type Bindings = Env["Bindings"];

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
