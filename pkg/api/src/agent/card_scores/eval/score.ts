import type { ExtractDataSchema, NineSchema } from "../schema";

// A 0–1 grade of one extraction against a reviewed fixture label, plus raw
// error counts by category:
//   - scores:   per-hole score cells and writtenTotals cells (per-nine + card)
//   - names:    player names, per nine and score-row position
//   - metadata: courseName, date, error, nineName, per-hole par
// The overall grade weights score cells hardest — getting the numbers right
// matters more than spelling a player's initials the way the reviewer did.
export type ScoreResult = {
  overall: number;
  errors: { scores: number; names: number; metadata: number };
};

const WEIGHTS = { scores: 3, names: 2, metadata: 1 } as const;
type Category = keyof typeof WEIGHTS;

// Nines are matched by hole-number overlap, not array position — the label
// may list the back nine first (physical card order) while a model emits
// hole 1 first, and that ordering difference isn't an extraction error.
function matchNines(
  got: ExtractDataSchema,
  expected: ExtractDataSchema,
): (NineSchema | undefined)[] {
  const remaining = [...got.nines];
  return expected.nines.map((expectedNine) => {
    const expectedHoles = new Set(expectedNine.holes.map((hole) => hole.hole));
    let best: { index: number; overlap: number } | undefined;
    remaining.forEach((gotNine, index) => {
      const overlap = gotNine.holes.filter((hole) => expectedHoles.has(hole.hole)).length;
      if (overlap > 0 && (best === undefined || overlap > best.overlap)) {
        best = { index, overlap };
      }
    });
    if (best === undefined) return undefined;
    return remaining.splice(best.index, 1)[0];
  });
}

// Graded against every field the EXPECTED label contains — a nine or hole
// missing from the output counts every one of its expected cells as errors.
// Extra invented nines/holes/players don't subtract here; they show up in
// the output.json diff during review.
export function score(got: ExtractDataSchema, expected: ExtractDataSchema): ScoreResult {
  const tallies: Record<Category, { errors: number; total: number }> = {
    scores: { errors: 0, total: 0 },
    names: { errors: 0, total: 0 },
    metadata: { errors: 0, total: 0 },
  };
  function tally(category: Category, gotValue: unknown, expectedValue: unknown) {
    tallies[category].total += 1;
    if (gotValue !== expectedValue) tallies[category].errors += 1;
  }

  // Names (player, nine, course) are graded case-insensitively — "ASHLEY" vs
  // "Ashley" is transcription convention, not a misread, and the labels
  // themselves aren't consistent about casing.
  function caseFolded(value: string | null | undefined): string | null | undefined {
    return typeof value === "string" ? value.toLowerCase() : value;
  }

  tally("metadata", caseFolded(got.courseName), caseFolded(expected.courseName));
  tally("metadata", got.date, expected.date);
  tally("metadata", got.error, expected.error);

  const matchedNines = matchNines(got, expected);
  expected.nines.forEach((expectedNine, nineIndex) => {
    const gotNine = matchedNines[nineIndex];
    tally("metadata", caseFolded(gotNine?.nineName), caseFolded(expectedNine.nineName));

    expectedNine.players.forEach((expectedName, playerIndex) => {
      tally("names", caseFolded(gotNine?.players[playerIndex]), caseFolded(expectedName));
      tally(
        "scores",
        gotNine?.writtenTotals[playerIndex] ?? null,
        expectedNine.writtenTotals[playerIndex] ?? null,
      );
    });

    for (const expectedHole of expectedNine.holes) {
      const gotHole = gotNine?.holes.find((hole) => hole.hole === expectedHole.hole);
      tally("metadata", gotHole?.par, expectedHole.par);
      expectedNine.players.forEach((_, playerIndex) => {
        tally(
          "scores",
          gotHole ? (gotHole.scores[playerIndex] ?? null) : undefined,
          expectedHole.scores[playerIndex] ?? null,
        );
      });
    }
  });

  expected.writtenTotals.forEach((expectedTotal, playerIndex) => {
    tally("scores", got.writtenTotals[playerIndex] ?? null, expectedTotal);
  });

  let weightedErrors = 0;
  let weightedTotal = 0;
  for (const category of Object.keys(WEIGHTS) as Category[]) {
    weightedErrors += WEIGHTS[category] * tallies[category].errors;
    weightedTotal += WEIGHTS[category] * tallies[category].total;
  }

  return {
    overall:
      weightedTotal === 0 ? 1 : Math.round((1 - weightedErrors / weightedTotal) * 1000) / 1000,
    errors: {
      scores: tallies.scores.errors,
      names: tallies.names.errors,
      metadata: tallies.metadata.errors,
    },
  };
}
