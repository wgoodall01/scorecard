// Vitest setup: bring the test D1 up to the current schema. The migrations
// are read on the Node side in vitest.config.ts and passed in as the
// TEST_MIGRATIONS binding — a test-only binding that deliberately isn't part
// of the Worker Env type, hence the cast.
import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(env.DB, TEST_MIGRATIONS);
