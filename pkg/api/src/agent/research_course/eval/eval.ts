#!/usr/bin/env bun
// Eval CLI for the research_course agent — real model calls that reconcile one
// or more course layouts (a GolfCourseAPI feed and/or a card_metadata photo
// reading) with the USGA mirror into a CourseProposal, graded against reviewed
// labels. Fixtures live in ./fixtures/<label>/{layouts.json,usga.json,
// proposal.json}. Runs in plain Bun/Node (no wrangler/workerd):
// models resolve via evalModel (AI Gateway REST + AI_GATEWAY_TOKEN from the
// repo-root .env.local).
//
//   ./eval.ts run                                   # default models, all fixtures
//   ./eval.ts run --models openai/gpt-5.4-mini@low --fixtures bhf
//   ./eval.ts score                                 # re-score results/latest
//
// `run` writes results/<stamp>/<fixture>/<provider>__<model>__<effort>/
// output.json (gitignored), keeps results/latest symlinked, and scores itself.
// `score` re-grades a past run against the current labels without model calls.
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
import { researchCourse } from "../agent";
import { CourseProposal, type CourseProposalSchema } from "../schema";
import { loadFixtures } from "./fixtures";
import { score } from "./score";

const evalDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../../..", import.meta.url));

const DEFAULT_MODELS: ModelSpec[] = ["openai/gpt-5.4-mini@low"];

const CONCURRENCY = 8;

function specDirName(spec: ModelSpec): string {
  return spec.replaceAll("/", "__").replace("@", "__");
}

function runStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}` +
    `__${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`
  );
}

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

function loadLabels(): Map<string, CourseProposalSchema> {
  const labels = new Map<string, CourseProposalSchema>();
  const fixturesDir = join(evalDir, "fixtures");
  for (const label of readdirSync(fixturesDir)) {
    const path = join(fixturesDir, label, "proposal.json");
    if (!statSync(join(fixturesDir, label)).isDirectory() || !existsSync(path)) continue;
    const parsed = CourseProposal.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!parsed.success) {
      throw new Error(`Fixture "${label}" has an invalid proposal.json: ${parsed.error}`);
    }
    labels.set(label, parsed.data);
  }
  return labels;
}

function scoreRun(runDir: string) {
  const labels = loadLabels();
  for (const fixture of readdirSync(runDir).sort()) {
    if (!statSync(join(runDir, fixture)).isDirectory()) continue;
    for (const slug of readdirSync(join(runDir, fixture)).sort()) {
      const caseDir = join(runDir, fixture, slug);
      const caseName = `${fixture} × ${slug}`;
      const output = JSON.parse(readFileSync(join(caseDir, "output.json"), "utf-8")) as unknown;
      const scorePath = join(caseDir, "score.json");

      if (typeof (output as { error?: unknown }).error === "string") {
        rmSync(scorePath, { force: true });
        console.log(`      ${caseName} → research error`);
        continue;
      }
      const expected = labels.get(fixture);
      if (expected === undefined) {
        console.log(`      ${caseName} → unlabeled`);
        continue;
      }
      const graded = score(CourseProposal.parse(output), expected);
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
  description: "Reconcile every model × fixture case, then score the run.",
  args: {
    models: option({
      type: optional(string),
      long: "models",
      description:
        'Comma-separated model specs ("provider/model@effort"). Default: openai/gpt-5.4-mini@low.',
    }),
    fixtures: option({
      type: optional(string),
      long: "fixtures",
      description: "Comma-separated fixture labels. Default: all.",
    }),
  },
  handler: async (args) => {
    loadGatewayEnv();

    const requested = args.models?.split(",").map((entry) => entry.trim()) ?? DEFAULT_MODELS;
    const specs = requested.map((entry) => {
      parseModelSpec(entry);
      return entry as ModelSpec;
    });

    let fixtures = loadFixtures(join(evalDir, "fixtures"));
    if (args.fixtures) {
      const wanted = args.fixtures.split(",").map((label) => label.trim());
      const known = new Set(fixtures.map((fixture) => fixture.label));
      const unknown = wanted.filter((label) => !known.has(label));
      if (unknown.length > 0) {
        throw new Error(`Unknown fixture(s): ${unknown.join(", ")}`);
      }
      fixtures = fixtures.filter((fixture) => wanted.includes(fixture.label));
    }

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
          const data = await researchCourse({
            layouts: fixture.layouts,
            usga: fixture.usga,
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
  description: "Run and grade research_course agent evals.",
  cmds: { run: runCommand, score: scoreCommand },
});

await runCli(app, process.argv.slice(2));
