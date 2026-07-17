import { Hono } from "hono";
import type { CaptureQueueMessage, Env } from "./env";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { captureRoutes } from "./routes/capture";
import { healthRoutes } from "./routes/health";
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
  InviteRequest,
  UpdateUserRequest,
  type InviteRequestSchema,
  type UpdateUserRequestSchema,
} from "./routes/admin";
export { Email, type EmailSchema } from "./routes/shared";

const app = new Hono<Env>()
  .basePath("/api")
  .route("/", healthRoutes)
  .route("/", captureRoutes)
  .route("/", authRoutes)
  .route("/", userRoutes)
  .route("/", adminRoutes);

export type AppType = typeof app;

export default {
  fetch: app.fetch,
  queue: handleCaptureQueue,
} satisfies ExportedHandler<Env["Bindings"], CaptureQueueMessage>;
