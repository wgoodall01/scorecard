import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Eval tests call the real vision model and cost real money/time; they run
    // separately via `bun run eval`, not as part of the regular test suite.
    exclude: [...configDefaults.exclude, "eval/**"],
    // model.test.ts needs the remote AI binding proxy, which flakes ("Network
    // connection lost" on every case) when another workerd test file runs in
    // parallel with it. The suite is tiny; run files sequentially.
    fileParallelism: false,
    // Applies TEST_MIGRATIONS to the test D1 before each test file.
    setupFiles: ["./test/apply-migrations.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.toml" },
      miniflare: {
        bindings: {
          JWT_SECRET: "test-jwt-secret",
          AUTHN_CHALLENGE_SIGNING_SECRET: "test-challenge-secret",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
});
