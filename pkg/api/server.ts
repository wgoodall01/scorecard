import { Hono } from "hono";
import type { Env } from "./env";
import { authRoutes } from "./routes/auth";
import { captureRoutes } from "./routes/capture";
import { healthRoutes } from "./routes/health";
import { userRoutes } from "./routes/users";

export type { Env } from "./env";
export {
  AuthCodeRequest,
  AuthTokenRequest,
  RegistrationRequest,
  type AuthCodeRequestSchema,
  type AuthTokenRequestSchema,
  type RegistrationRequestSchema,
} from "./routes/auth";
export { Email, type EmailSchema } from "./routes/shared";

const app = new Hono<Env>()
  .basePath("/api")
  .route("/", healthRoutes)
  .route("/", captureRoutes)
  .route("/", authRoutes)
  .route("/", userRoutes);

export type AppType = typeof app;

export default app;
