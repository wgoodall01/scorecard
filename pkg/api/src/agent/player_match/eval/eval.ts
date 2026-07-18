#!/usr/bin/env bun
// Eval CLI for the player_match agent — real model calls, but the database is
// an in-memory roster per fixture (playerSearchFromRoster), so this runs in
// plain Bun with no wrangler/workerd. See src/agent/match_eval.ts for the
// harness and the precision/recall grading rules.
//
//   ./eval.ts run                                    # default model trio, all fixtures
//   ./eval.ts run --models openai/gpt-5.4-nano@low   # a specific slice
//   ./eval.ts score                                  # re-score results/latest
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { z } from "zod";
import { evalModel, type ModelSpec } from "../../../model";
import { type MatchEvalCase, runMatchEvalCli } from "../../match_eval";
import { matchPlayers } from "../agent";
import { playerSearchFromRoster } from "../search";

const evalDir = fileURLToPath(new URL(".", import.meta.url));

const Fixture = z.object({
  roster: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      nicknames: z.array(z.string()),
    }),
  ),
  cases: z.array(
    z.object({
      label: z.string(),
      names: z.array(z.string()).min(1),
      expect: z.array(z.string().nullable()),
      note: z.string().optional(),
    }),
  ),
});

function loadCases(): Promise<MatchEvalCase[]> {
  const fixturesDir = join(evalDir, "fixtures");
  const cases: MatchEvalCase[] = [];
  for (const file of readdirSync(fixturesDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const fixtureLabel = file.replace(/\.json$/, "");
    const parsed = Fixture.safeParse(JSON.parse(readFileSync(join(fixturesDir, file), "utf-8")));
    if (!parsed.success) {
      throw new Error(`Fixture "${fixtureLabel}" is invalid: ${parsed.error}`);
    }
    const { roster, cases: fixtureCases } = parsed.data;
    const rosterIds = new Set(roster.map((player) => player.id));

    for (const entry of fixtureCases) {
      if (entry.expect.length !== entry.names.length) {
        throw new Error(
          `Fixture "${fixtureLabel}" case "${entry.label}": expect/names length mismatch`,
        );
      }
      for (const id of entry.expect) {
        if (id !== null && !rosterIds.has(id)) {
          throw new Error(
            `Fixture "${fixtureLabel}" case "${entry.label}": unknown roster id ${id}`,
          );
        }
      }
      cases.push({
        fixture: fixtureLabel,
        label: entry.label,
        expected: entry.expect,
        run: async (model: ModelSpec) => {
          const matches = await matchPlayers({
            names: entry.names,
            search: playerSearchFromRoster(roster),
            resolver: evalModel,
            model,
          });
          return { output: matches, got: matches.map((match) => match.userId) };
        },
      });
    }
  }
  return Promise.resolve(cases);
}

const DEFAULT_MODELS: ModelSpec[] = [
  "openai/gpt-5.4-mini@medium",
  "openai/gpt-5.4-nano@medium",
  "google/gemini-3.5-flash@low",
];

await runMatchEvalCli({
  name: "player_match",
  evalDir,
  defaultModels: DEFAULT_MODELS,
  loadCases,
});
