#!/usr/bin/env bun
// Eval CLI for the card_scores agent — real vision-model calls against the
// fixtures in ./scorecard/<label>/{image.*,extracted.json}. Runs in plain
// Bun/Node (no wrangler/workerd): models resolve via evalModel (AI Gateway
// REST + AI_GATEWAY_TOKEN from the repo-root .env.local).
//
//   ./eval.ts run                                             # default model trio, all fixtures
//   ./eval.ts run --models google/gemini-3.5-flash@low \
//                 --fixtures bhf-01,bhf-05                    # a specific slice
//   ./eval.ts score                                           # re-score results/latest
//   ./eval.ts score 2026_07_17__14_07_37                      # re-score a past run
//
// `run` writes results/<YYYY_MM_DD__HH_MM_SS>/<fixture>/
// <provider>__<model>__<effort>/output.json (gitignored), keeps results/latest
// symlinked to the newest run, and scores itself when extraction finishes.
// `score` re-grades a past run's outputs against the CURRENT fixture labels
// and score() criteria (see score.ts), rewriting each case's score.json — so
// changing the grading rules never requires re-spending model calls.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { command, option, optional, positional, run as runCli, string, subcommands } from "cmd-ts";
import pMap from "p-map";
import { evalModel, type ModelSpec, parseModelSpec } from "../../../model";
import { extractScorecard } from "../agent";
import { ExtractData, type ExtractDataSchema } from "../schema";
import { loadFixtures } from "./fixtures";
import { score } from "./score";

const evalDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../../..", import.meta.url));

const DEFAULT_MODELS: ModelSpec[] = [
  "google/gemini-3.5-flash@low",
  "anthropic/claude-sonnet-5@low",
  "openai/gpt-5.6-terra@low",
];

const CONCURRENCY = 8;

// "google/gemini-3.5-flash@low" → "google__gemini-3.5-flash__low"
function specDirName(spec: ModelSpec): string {
  return spec.replaceAll("/", "__").replace("@", "__");
}

// Local-time run stamp: "2026_07_17__14_05_33"
function runStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}` +
    `__${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`
  );
}

// evalModel reads gateway coordinates from the environment: the non-secret
// ones come from wrangler.toml (single source of truth), the token from the
// repo-root .env.local.
function loadGatewayEnv() {
  const wranglerToml = readFileSync(join(repoRoot, "wrangler.toml"), "utf-8");
  const accountId = /^account_id\s*=\s*"([^"]+)"/m.exec(wranglerToml)?.[1];
  const gatewayId = /^AI_GATEWAY_ID\s*=\s*"([^"]+)"/m.exec(wranglerToml)?.[1];
  if (!accountId || !gatewayId) {
    throw new Error("Could not read account_id / AI_GATEWAY_ID from wrangler.toml");
  }
  process.env.CLOUDFLARE_ACCOUNT_ID ??= accountId;
  process.env.AI_GATEWAY_ID ??= gatewayId;
  try {
    for (const line of readFileSync(join(repoRoot, ".env.local"), "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.trimStart().startsWith("#")) {
        process.env[line.slice(0, eq).trim()] ??= line.slice(eq + 1).trim();
      }
    }
  } catch {
    // no .env.local — evalModel will throw a pointed error about the token
  }
}

// Parses each labeled fixture's reviewed extracted.json, throwing with the
// fixture's name on a malformed label.
function loadLabels(): Map<string, ExtractDataSchema> {
  const labels = new Map<string, ExtractDataSchema>();
  const scorecardDir = join(evalDir, "scorecard");
  for (const label of readdirSync(scorecardDir)) {
    const path = join(scorecardDir, label, "extracted.json");
    if (!statSync(join(scorecardDir, label)).isDirectory() || !existsSync(path)) continue;
    const parsed = ExtractData.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!parsed.success) {
      throw new Error(`Fixture "${label}" has an invalid extracted.json: ${parsed.error}`);
    }
    labels.set(label, parsed.data);
  }
  return labels;
}

// (Re-)grades every case in a run directory against the current labels and
// score() criteria, rewriting score.json next to each output.json.
function scoreRun(runDir: string) {
  const labels = loadLabels();
  for (const fixture of readdirSync(runDir).sort()) {
    if (!statSync(join(runDir, fixture)).isDirectory()) continue;
    for (const slug of readdirSync(join(runDir, fixture)).sort()) {
      const caseDir = join(runDir, fixture, slug);
      const caseName = `${fixture} × ${slug}`;
      const output = JSON.parse(readFileSync(join(caseDir, "output.json"), "utf-8")) as unknown;
      const scorePath = join(caseDir, "score.json");

      // A failed case's output.json is `{error: "…"}`; successful extractions
      // carry `error: null` (the agent throws on a non-null model error).
      if (typeof (output as { error?: unknown }).error === "string") {
        rmSync(scorePath, { force: true }); // never leave a stale grade next to an error
        console.log(`      ${caseName} → extraction error`);
        continue;
      }
      const expected = labels.get(fixture);
      if (expected === undefined) {
        console.log(`      ${caseName} → unlabeled`);
        continue;
      }
      const graded = score(ExtractData.parse(output), expected);
      writeFileSync(scorePath, `${JSON.stringify(graded, null, 2)}\n`);
      const errorNote = Object.entries(graded.errors)
        .filter(([, count]) => count > 0)
        .map(([category, count]) => `${category} ${count}`)
        .join(", ");
      console.log(`      ${caseName} → ${graded.overall}${errorNote ? ` (${errorNote})` : ""}`);
    }
  }
}

function resolveRunDir(name: string): string {
  const runDir = join(evalDir, "results", name);
  if (!existsSync(runDir)) {
    throw new Error(`No such run: ${runDir}`);
  }
  return runDir;
}

const runCommand = command({
  name: "run",
  description: "Extract every model × fixture case, then score the run.",
  args: {
    models: option({
      type: optional(string),
      long: "models",
      description:
        'Comma-separated model specs ("provider/model@effort"). Default: ' +
        "gemini-3.5-flash, claude-sonnet-5, gpt-5.6-terra (each @low).",
    }),
    fixtures: option({
      type: optional(string),
      long: "fixtures",
      description: "Comma-separated fixture labels (e.g. bhf-01,bhf-05). Default: all.",
    }),
  },
  handler: async (args) => {
    loadGatewayEnv();

    const requested = args.models?.split(",").map((entry) => entry.trim()) ?? DEFAULT_MODELS;
    const specs = requested.map((entry) => {
      parseModelSpec(entry); // throws on malformed specs and known-invalid combos
      return entry as ModelSpec;
    });

    let fixtures = await loadFixtures(join(evalDir, "scorecard"));
    if (args.fixtures) {
      const wanted = args.fixtures.split(",").map((label) => label.trim());
      const known = new Set(fixtures.map((fixture) => fixture.label));
      const unknown = wanted.filter((label) => !known.has(label));
      if (unknown.length > 0) {
        throw new Error(`Unknown fixture(s): ${unknown.join(", ")}`);
      }
      fixtures = fixtures.filter((fixture) => wanted.includes(fixture.label));
    }

    // Each run writes under results/<stamp>/, with results/latest always
    // pointing at the most recent run.
    const stamp = runStamp();
    const runDir = join(evalDir, "results", stamp);
    mkdirSync(runDir, { recursive: true });
    const latestLink = join(evalDir, "results", "latest");
    rmSync(latestLink, { force: true });
    symlinkSync(stamp, latestLink);

    const cases = specs.flatMap((spec) => fixtures.map((fixture) => ({ spec, fixture })));
    console.log(
      `Running ${cases.length} cases (${specs.length} models × ${fixtures.length} fixtures, ` +
        `${CONCURRENCY}-way parallel)…`,
    );

    let failures = 0;
    await pMap(
      cases,
      async ({ spec, fixture }) => {
        const outDir = join(runDir, fixture.label, specDirName(spec));
        mkdirSync(outDir, { recursive: true });
        const caseName = `${fixture.label} × ${spec}`;

        try {
          const data = await extractScorecard({
            image: { buf: fixture.bytes, contentType: fixture.contentType },
            resolver: evalModel,
            model: spec,
          });
          writeFileSync(join(outDir, "output.json"), `${JSON.stringify(data, null, 2)}\n`);
          console.log(`ok    ${caseName}`);
        } catch (error) {
          failures += 1;
          writeFileSync(
            join(outDir, "output.json"),
            `${JSON.stringify({ error: String(error) }, null, 2)}\n`,
          );
          console.error(`ERROR ${caseName}: ${String(error).slice(0, 200)}`);
        }
      },
      { concurrency: CONCURRENCY },
    );

    console.log("\nScores:");
    scoreRun(runDir);
    console.log(`\nresults → ${runDir} (symlinked as results/latest)`);
    if (failures > 0) {
      console.error(`${failures} case(s) errored`);
      process.exit(1);
    }
  },
});

const scoreCommand = command({
  name: "score",
  description:
    "Re-grade a past run's outputs against the current fixture labels and score() " +
    "criteria, rewriting each case's score.json. No model calls.",
  args: {
    run: positional({
      type: optional(string),
      displayName: "run",
      description: 'Run directory name under results/ (default: "latest").',
    }),
  },
  handler: (args) => {
    scoreRun(resolveRunDir(args.run ?? "latest"));
  },
});

const app = subcommands({
  name: "eval",
  description: "Run and grade card_scores agent evals.",
  cmds: { run: runCommand, score: scoreCommand },
});

await runCli(app, process.argv.slice(2));
