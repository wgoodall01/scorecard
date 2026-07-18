#!/usr/bin/env bun
// Eval CLI for the course_match agent — real model calls (when the exact
// par-sequence phase doesn't already resolve a case), but the database is an
// in-memory course list per fixture (courseSearchFromList /
// courseSetParsFromList), so this runs in plain Bun with no wrangler/workerd.
// Each case grades the course slot plus one slot per nine; see
// src/agent/match_eval.ts for the harness and the precision/recall grading.
//
// Fixture sets and case nines carry `firstHole` + `pars` (holes derived), so
// cases can exercise both the exact phase (verbatim par match) and the LLM
// fallback (misread pars / generic names).
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
import { matchCourseSets } from "../agent";
import { courseSearchFromList, courseSetParsFromList } from "../search";

const evalDir = fileURLToPath(new URL(".", import.meta.url));

const ParLayout = z.object({
  firstHole: z.number().int().min(1).max(18),
  pars: z.array(z.number().int().min(1)).min(1),
});

const Fixture = z.object({
  courses: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      location: z.string().nullable(),
      sets: z.array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            disposition: z.enum(["front", "back"]).nullable(),
          })
          .and(ParLayout),
      ),
    }),
  ),
  cases: z.array(
    z.object({
      label: z.string(),
      courseName: z.string().nullable(),
      nines: z.array(z.object({ name: z.string().nullable() }).and(ParLayout)),
      expect: z.object({
        courseId: z.string().nullable(),
        sets: z.array(z.string().nullable()),
      }),
      note: z.string().optional(),
    }),
  ),
});

function holesFrom(layout: { firstHole: number; pars: number[] }) {
  return layout.pars.map((par, index) => ({ number: layout.firstHole + index, par }));
}

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
    const { courses, cases: fixtureCases } = parsed.data;
    const knownIds = new Set([
      ...courses.map((course) => course.id),
      ...courses.flatMap((course) => course.sets.map((set) => set.id)),
    ]);
    const searchable = courses.map((course) => ({
      id: course.id,
      name: course.name,
      location: course.location,
      sets: course.sets.map((set) => ({
        id: set.id,
        name: set.name,
        disposition: set.disposition,
      })),
    }));
    const setPars = courses.flatMap((course) =>
      course.sets.map((set) => ({
        courseId: course.id,
        courseSetId: set.id,
        holes: holesFrom(set),
      })),
    );

    for (const entry of fixtureCases) {
      if (entry.expect.sets.length !== entry.nines.length) {
        throw new Error(
          `Fixture "${fixtureLabel}" case "${entry.label}": expect/nines length mismatch`,
        );
      }
      for (const id of [entry.expect.courseId, ...entry.expect.sets]) {
        if (id !== null && !knownIds.has(id)) {
          throw new Error(`Fixture "${fixtureLabel}" case "${entry.label}": unknown id ${id}`);
        }
      }
      cases.push({
        fixture: fixtureLabel,
        label: entry.label,
        // Slot 0 is the course, then one slot per nine, in input order.
        expected: [entry.expect.courseId, ...entry.expect.sets],
        run: async (model: ModelSpec) => {
          const result = await matchCourseSets({
            courseName: entry.courseName,
            nines: entry.nines.map((nine) => ({ name: nine.name, holes: holesFrom(nine) })),
            search: courseSearchFromList(searchable),
            listSetPars: courseSetParsFromList(setPars),
            resolver: evalModel,
            model,
          });
          return {
            output: result,
            got: [result.courseId, ...result.sets.map((set) => set.courseSetId)],
          };
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
  name: "course_match",
  evalDir,
  defaultModels: DEFAULT_MODELS,
  loadCases,
});
