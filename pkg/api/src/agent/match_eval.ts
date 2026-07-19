// Shared harness for the matching-agent evals (player_match, course_match),
// in the same style as card_scores/eval/eval.ts: a plain-Bun cmd-ts CLI with
// `run` (real model calls through evalModel) and `score` (re-grade a past run
// without re-spending model calls), writing results/<stamp>/… with a
// results/latest symlink.
//
// Matching is graded as retrieval: each answer slot holds an id or null, and
// slots score as tp (right id), fn (missed id), fp (wrong or invented id —
// a wrong id also counts an fn for the id it displaced), or tn (correctly
// null). Precision = tp/(tp+fp), recall = tp/(tp+fn).
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
import { type ModelSpec, parseModelSpec } from "../model";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const CONCURRENCY = 8;

// A wrong id counts BOTH as an fp (a bad match was asserted) and an fn (the
// right id was missed), so fp+fn can exceed the slot count — `slots` and
// `correct` are tracked separately for accuracy.
export type MatchCounts = { tp: number; fp: number; fn: number; tn: number; slots: number };

export type MatchScore = MatchCounts & {
  precision: number | null;
  recall: number | null;
  accuracy: number;
};

export function matchCounts(expected: (string | null)[], got: (string | null)[]): MatchCounts {
  const counts: MatchCounts = { tp: 0, fp: 0, fn: 0, tn: 0, slots: expected.length };
  expected.forEach((expectedId, index) => {
    const gotId = got[index] ?? null;
    if (expectedId === null) {
      if (gotId === null) counts.tn += 1;
      else counts.fp += 1;
    } else if (gotId === null) {
      counts.fn += 1;
    } else if (gotId === expectedId) {
      counts.tp += 1;
    } else {
      counts.fp += 1;
      counts.fn += 1;
    }
  });
  return counts;
}

export function summarizeCounts(counts: MatchCounts): MatchScore {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    ...counts,
    precision: counts.tp + counts.fp === 0 ? null : round(counts.tp / (counts.tp + counts.fp)),
    recall: counts.tp + counts.fn === 0 ? null : round(counts.tp / (counts.tp + counts.fn)),
    accuracy: counts.slots === 0 ? 1 : round((counts.tp + counts.tn) / counts.slots),
  };
}

export type MatchEvalCase = {
  fixture: string;
  label: string;
  expected: (string | null)[];
  run: (model: ModelSpec) => Promise<{ output: unknown; got: (string | null)[] }>;
};

type CaseOutput = {
  expected: (string | null)[];
  got: (string | null)[];
  output: unknown;
  durationMs?: number;
  error?: string;
};

// p-th percentile (0–100) of a sample by linear interpolation, or null when
// empty. Used for the latency benchmark printed alongside accuracy.
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (rank - low));
}

function latencyLine(durations: number[]): string {
  if (durations.length === 0) return "latency n/a";
  const mean = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
  return `latency mean ${mean}ms, median ${percentile(durations, 50)}ms, p75 ${percentile(durations, 75)}ms, p95 ${percentile(durations, 95)}ms (n=${durations.length})`;
}

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
export function loadGatewayEnv() {
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

// (Re-)grades every case in a run directory against the CURRENT fixture
// expectations, rewriting score.json next to each output.json, and prints a
// per-model aggregate — the number that picks the default model.
function scoreRun(runDir: string, cases: MatchEvalCase[]) {
  const currentExpected = new Map(
    cases.map((entry) => [`${entry.fixture}/${entry.label}`, entry.expected]),
  );
  const perModel = new Map<string, MatchCounts>();
  const perModelDurations = new Map<string, number[]>();

  for (const fixture of readdirSync(runDir).sort()) {
    if (!statSync(join(runDir, fixture)).isDirectory()) continue;
    for (const caseLabel of readdirSync(join(runDir, fixture)).sort()) {
      for (const slug of readdirSync(join(runDir, fixture, caseLabel)).sort()) {
        const caseDir = join(runDir, fixture, caseLabel, slug);
        const caseName = `${fixture}/${caseLabel} × ${slug}`;
        const output = JSON.parse(
          readFileSync(join(caseDir, "output.json"), "utf-8"),
        ) as CaseOutput;
        const scorePath = join(caseDir, "score.json");

        if (output.error !== undefined) {
          rmSync(scorePath, { force: true }); // never leave a stale grade next to an error
          console.log(`      ${caseName} → agent error`);
          continue;
        }
        if (typeof output.durationMs === "number") {
          perModelDurations.set(slug, [...(perModelDurations.get(slug) ?? []), output.durationMs]);
        }
        const expected = currentExpected.get(`${fixture}/${caseLabel}`) ?? output.expected;
        const counts = matchCounts(expected, output.got);
        const score = summarizeCounts(counts);
        writeFileSync(scorePath, `${JSON.stringify(score, null, 2)}\n`);

        const aggregate = perModel.get(slug) ?? { tp: 0, fp: 0, fn: 0, tn: 0, slots: 0 };
        aggregate.tp += counts.tp;
        aggregate.fp += counts.fp;
        aggregate.fn += counts.fn;
        aggregate.tn += counts.tn;
        aggregate.slots += counts.slots;
        perModel.set(slug, aggregate);

        const misses = counts.fp + counts.fn;
        console.log(
          `      ${caseName} → ${score.accuracy}${misses > 0 ? ` (fp ${counts.fp}, fn ${counts.fn})` : ""}`,
        );
      }
    }
  }

  console.log("\nPer-model aggregate:");
  for (const [slug, counts] of [...perModel.entries()].sort()) {
    const score = summarizeCounts(counts);
    console.log(
      `  ${slug}: accuracy ${score.accuracy}, precision ${score.precision ?? "n/a"}, ` +
        `recall ${score.recall ?? "n/a"} (tp ${counts.tp}, fp ${counts.fp}, fn ${counts.fn}, tn ${counts.tn})`,
    );
    console.log(`    ${latencyLine(perModelDurations.get(slug) ?? [])}`);
  }
}

export async function runMatchEvalCli({
  name,
  evalDir,
  defaultModels,
  loadCases,
}: {
  name: string;
  evalDir: string;
  defaultModels: ModelSpec[];
  loadCases: () => Promise<MatchEvalCase[]>;
}) {
  const runCommand = command({
    name: "run",
    description: "Run every model × case, then score the run.",
    args: {
      models: option({
        type: optional(string),
        long: "models",
        description:
          'Comma-separated model specs ("provider/model@effort"). Default: ' +
          defaultModels.join(", "),
      }),
      fixtures: option({
        type: optional(string),
        long: "fixtures",
        description: "Comma-separated fixture labels. Default: all.",
      }),
    },
    handler: async (args) => {
      loadGatewayEnv();

      const requested = args.models?.split(",").map((entry) => entry.trim()) ?? defaultModels;
      const specs = requested.map((entry) => {
        parseModelSpec(entry); // throws on malformed specs and known-invalid combos
        return entry as ModelSpec;
      });

      let cases = await loadCases();
      if (args.fixtures) {
        const wanted = args.fixtures.split(",").map((label) => label.trim());
        const known = new Set(cases.map((entry) => entry.fixture));
        const unknown = wanted.filter((label) => !known.has(label));
        if (unknown.length > 0) {
          throw new Error(`Unknown fixture(s): ${unknown.join(", ")}`);
        }
        cases = cases.filter((entry) => wanted.includes(entry.fixture));
      }

      const stamp = runStamp();
      const runDir = join(evalDir, "results", stamp);
      mkdirSync(runDir, { recursive: true });
      const latestLink = join(evalDir, "results", "latest");
      rmSync(latestLink, { force: true });
      symlinkSync(stamp, latestLink);

      const jobs = specs.flatMap((spec) => cases.map((entry) => ({ spec, entry })));
      console.log(
        `Running ${jobs.length} ${name} cases (${specs.length} models × ${cases.length} cases, ` +
          `${CONCURRENCY}-way parallel)…`,
      );

      let failures = 0;
      await pMap(
        jobs,
        async ({ spec, entry }) => {
          const outDir = join(runDir, entry.fixture, entry.label, specDirName(spec));
          mkdirSync(outDir, { recursive: true });
          const caseName = `${entry.fixture}/${entry.label} × ${spec}`;

          try {
            const startedAt = Date.now();
            const { output, got } = await entry.run(spec);
            const durationMs = Date.now() - startedAt;
            const record: CaseOutput = { expected: entry.expected, got, output, durationMs };
            writeFileSync(join(outDir, "output.json"), `${JSON.stringify(record, null, 2)}\n`);
            console.log(`ok    ${caseName} (${durationMs}ms)`);
          } catch (error) {
            failures += 1;
            const record: CaseOutput = {
              expected: entry.expected,
              got: [],
              output: null,
              error: String(error),
            };
            writeFileSync(join(outDir, "output.json"), `${JSON.stringify(record, null, 2)}\n`);
            console.error(`ERROR ${caseName}: ${String(error).slice(0, 200)}`);
          }
        },
        { concurrency: CONCURRENCY },
      );

      console.log("\nScores:");
      scoreRun(runDir, cases);
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
      "Re-grade a past run's outputs against the current fixture expectations, rewriting " +
      "each case's score.json. No model calls.",
    args: {
      run: positional({
        type: optional(string),
        displayName: "run",
        description: 'Run directory name under results/ (default: "latest").',
      }),
    },
    handler: async (args) => {
      const runDir = join(evalDir, "results", args.run ?? "latest");
      if (!existsSync(runDir)) {
        throw new Error(`No such run: ${runDir}`);
      }
      scoreRun(runDir, await loadCases());
    },
  });

  const app = subcommands({
    name,
    description: `Run and grade ${name} agent evals.`,
    cmds: { run: runCommand, score: scoreCommand },
  });

  await runCli(app, process.argv.slice(2));
}
