import { Hono } from "hono";
import type { CaptureQueueMessage, Env } from "./env";
import { authRoutes } from "./routes/auth";
import { scorecardRoutes } from "./routes/scorecard";
import { golferRoutes } from "./routes/golfers";
import { healthRoutes } from "./routes/health";
import { honorRoutes } from "./routes/honors";
import { outingRoutes } from "./routes/outings";
import { userRoutes } from "./routes/users";
import { handleCaptureQueue } from "./src/agent/card_extract/agent";

export type { Env } from "./env";
export {
  AuthCodeRequest,
  AuthTokenRequest,
  type AuthCodeRequestSchema,
  type AuthTokenRequestSchema,
} from "./routes/auth";
export {
  InviteGolferRequest,
  UpdateGolferRequest,
  type InviteGolferRequestSchema,
  type UpdateGolferRequestSchema,
} from "./routes/golfers";
export { SubmitOutingRequest, type SubmitOutingRequestSchema } from "./routes/outings";
export type { Honor, HonorHolder, HonorOutingRef, HonorSlug } from "./src/honors";
export type { HandicapPoint, PlayerHandicap } from "./src/handicap";
export { Email, type EmailSchema } from "./routes/shared";
export {
  ScorecardExtractRequest,
  type ScorecardExtractRequestSchema,
  type ScorecardStatus,
} from "./routes/scorecard";
export { TEES, type Tee } from "./schema";
export type { MatchedData } from "./src/agent/card_extract/agent";
export type { ExtractDataSchema, NineSchema } from "./src/agent/card_extract/schema";

const app = new Hono<Env>()
  .basePath("/api")
  .route("/", healthRoutes)
  .route("/", scorecardRoutes)
  .route("/", authRoutes)
  .route("/", userRoutes)
  .route("/", golferRoutes)
  .route("/", outingRoutes)
  .route("/", honorRoutes);

export type AppType = typeof app;

export default {
  fetch: app.fetch,
  queue: handleCaptureQueue,
} satisfies ExportedHandler<Env["Bindings"], CaptureQueueMessage>;
