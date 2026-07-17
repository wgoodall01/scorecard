import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// The eval runs in PLAIN NODE — no wrangler, no workerd, no pool-workers.
// Models are reached through the AI Gateway's public REST endpoints via
// `evalModel` (see pkg/api/src/model_provider.ts), authenticated with the
// AI_GATEWAY_TOKEN from the repo-root .env.local. That keeps the eval loop
// fast to start and lets tests read fixtures / write result snapshots with
// ordinary fs access. resolveModel's binding path has its own coverage in
// src/model_provider.test.ts (the pool-workers suite).

const evalDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function parseEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const eq = line.indexOf("=");
          return [line.slice(0, eq), line.slice(eq + 1)];
        }),
    );
  } catch {
    return {};
  }
}

// Non-secret gateway coordinates come straight from wrangler.toml — the
// single source of truth — rather than being duplicated into env files.
const wranglerToml = readFileSync(`${repoRoot}/wrangler.toml`, "utf-8");
const accountId = /^account_id\s*=\s*"([^"]+)"/m.exec(wranglerToml)?.[1];
const gatewayId = /^AI_GATEWAY_ID\s*=\s*"([^"]+)"/m.exec(wranglerToml)?.[1];
if (!accountId || !gatewayId) {
  throw new Error("Could not read account_id / AI_GATEWAY_ID from wrangler.toml");
}

const envLocal = parseEnvFile(`${repoRoot}/.env.local`);

export default defineConfig({
  test: {
    root: evalDir,
    include: ["**/*.eval.test.ts"],
    // Real vision-model calls are much slower than unit tests — the slowest
    // models (fable, gemini pro) take a couple of minutes on a full card.
    testTimeout: 120_000,
    env: {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      AI_GATEWAY_ID: gatewayId,
      // evalModel throws a pointed error if this is absent.
      ...(envLocal.AI_GATEWAY_TOKEN ? { AI_GATEWAY_TOKEN: envLocal.AI_GATEWAY_TOKEN } : {}),
    },
  },
});
