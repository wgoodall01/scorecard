import type { ExtractDataSchema, NineSchema, PlayerBoxSchema } from "../schema";

// A 0–1 grade of one extraction against a reviewed fixture label, plus raw
// error counts by category:
//   - scores:   per-hole score cells and writtenTotals cells (per-nine + card)
//   - names:    player names, per nine and score-row position
//   - metadata: courseName, date, error, nineName, per-hole par
//   - bbox:     player-name bounding boxes (count that landed WILDLY off)
// The overall grade weights score cells hardest — getting the numbers right
// matters more than spelling a player's initials the way the reviewer did, and
// the box is only a review-thumbnail aid so it's weighted lightest.
export type ScoreResult = {
  overall: number;
  errors: { scores: number; names: number; metadata: number; bbox: number };
  // Mean box closeness (0–1) over the labeled boxes, or null when a fixture
  // labels no boxes. Reported as a percentage.
  bboxCloseness: number | null;
};

const WEIGHTS = { scores: 3, names: 2, metadata: 1 } as const;
type Category = keyof typeof WEIGHTS;

// Boxes are graded on closeness, not exact match — a little difference of
// opinion on where the scrawl starts is fine, being in a different part of the
// card is not. Closeness is 1 when the box centers coincide and falls linearly
// to 0 once they're BBOX_MISS_DISTANCE apart (as a fraction of the image), so a
// box a couple percent off still scores ~0.8 while a wildly misplaced one
// (e.g. the old un-rescaled coordinate bug) scores 0. Its weight in the
// overall grade is deliberately small.
const BBOX_WEIGHT = 1;
const BBOX_MISS_DISTANCE = 0.12;
const BBOX_POOR_CLOSENESS = 0.5; // below this a box is counted a "wildly off" error

function bboxCloseness(got: PlayerBoxSchema | null | undefined, expected: PlayerBoxSchema): number {
  if (!got) return 0;
  const distance = Math.hypot(
    got.x + got.width / 2 - (expected.x + expected.width / 2),
    got.y + got.height / 2 - (expected.y + expected.height / 2),
  );
  return Math.max(0, 1 - distance / BBOX_MISS_DISTANCE);
}

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

  // Box grading accumulates partial credit (closeness), separately from the
  // binary tallies: total weighted error is Σ(1 − closeness) over labeled boxes.
  let bboxErrorSum = 0;
  let bboxCount = 0;
  let bboxPoor = 0;

  const matchedNines = matchNines(got, expected);
  expected.nines.forEach((expectedNine, nineIndex) => {
    const gotNine = matchedNines[nineIndex];
    tally("metadata", caseFolded(gotNine?.nineName), caseFolded(expectedNine.nineName));

    // Only the best-reading `name` is graded here (case-insensitively); the
    // `guesses` are an ungraded review aid. The `bbox` is graded on closeness
    // below, but only for players the label gives a box.
    expectedNine.players.forEach((expectedPlayer, playerIndex) => {
      tally(
        "names",
        caseFolded(gotNine?.players[playerIndex]?.name),
        caseFolded(expectedPlayer.name),
      );
      if (expectedPlayer.bbox) {
        const closeness = bboxCloseness(gotNine?.players[playerIndex]?.bbox, expectedPlayer.bbox);
        bboxCount += 1;
        bboxErrorSum += 1 - closeness;
        if (closeness < BBOX_POOR_CLOSENESS) bboxPoor += 1;
      }
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
  // Boxes join the weighted grade as partial credit (Σ of 1 − closeness).
  weightedErrors += BBOX_WEIGHT * bboxErrorSum;
  weightedTotal += BBOX_WEIGHT * bboxCount;

  return {
    overall:
      weightedTotal === 0 ? 1 : Math.round((1 - weightedErrors / weightedTotal) * 1000) / 1000,
    errors: {
      scores: tallies.scores.errors,
      names: tallies.names.errors,
      metadata: tallies.metadata.errors,
      bbox: bboxPoor,
    },
    bboxCloseness:
      bboxCount === 0 ? null : Math.round((1 - bboxErrorSum / bboxCount) * 1000) / 1000,
  };
}
