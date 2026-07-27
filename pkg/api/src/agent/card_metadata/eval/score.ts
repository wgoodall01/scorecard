import type { CardMetadataSchema, MetadataNineSchema, MetadataTeeSchema } from "../schema";

// A 0–1 grade of one layout extraction against a reviewed fixture label, plus
// raw error counts by category:
//   - yardages: per-tee per-hole yardage cells (the bulk of the layout)
//   - pars:     per-tee per-hole par cells
//   - indexes:  per-hole stroke index (the printed handicap row). Weighted like
//               par: it decides where handicap strokes fall, and it's a row the
//               model has to not confuse with par or yardage.
//   - names:    nine names and tee names
// Number cells are weighted over names — getting the numbers right is the
// point; nine/tee spelling is transcription convention.
export type ScoreResult = {
  overall: number;
  errors: { yardages: number; pars: number; indexes: number; names: number };
};

const WEIGHTS = { yardages: 2, pars: 2, indexes: 2, names: 1 } as const;
type Category = keyof typeof WEIGHTS;

function caseFolded(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? value.toLowerCase() : value;
}

// Nines are matched by case-folded name — two nines can share the same hole
// numbers (e.g. two front-nine loops both numbered 1–9), so name is the only
// reliable key.
function matchNines(
  got: CardMetadataSchema,
  expected: CardMetadataSchema,
): (MetadataNineSchema | undefined)[] {
  const remaining = [...got.nines];
  return expected.nines.map((expectedNine) => {
    const index = remaining.findIndex(
      (gotNine) => caseFolded(gotNine.name) === caseFolded(expectedNine.name),
    );
    if (index === -1) return undefined;
    return remaining.splice(index, 1)[0];
  });
}

function matchTee(
  gotNine: MetadataNineSchema | undefined,
  expectedTee: MetadataTeeSchema,
): MetadataTeeSchema | undefined {
  return gotNine?.tees.find((tee) => caseFolded(tee.name) === caseFolded(expectedTee.name));
}

// Graded against every field the EXPECTED label contains — a nine, tee, or
// hole missing from the output counts every one of its expected cells as
// errors. Extra invented rows don't subtract here; they show up in the
// output.json diff during review.
export function score(got: CardMetadataSchema, expected: CardMetadataSchema): ScoreResult {
  const tallies: Record<Category, { errors: number; total: number }> = {
    yardages: { errors: 0, total: 0 },
    indexes: { errors: 0, total: 0 },
    pars: { errors: 0, total: 0 },
    names: { errors: 0, total: 0 },
  };
  function tally(category: Category, gotValue: unknown, expectedValue: unknown) {
    tallies[category].total += 1;
    if (gotValue !== expectedValue) tallies[category].errors += 1;
  }

  const matchedNines = matchNines(got, expected);
  expected.nines.forEach((expectedNine, nineIndex) => {
    const gotNine = matchedNines[nineIndex];
    tally("names", caseFolded(gotNine?.name), caseFolded(expectedNine.name));

    for (const expectedTee of expectedNine.tees) {
      const gotTee = matchTee(gotNine, expectedTee);
      tally("names", caseFolded(gotTee?.name), caseFolded(expectedTee.name));

      for (const expectedHole of expectedTee.holes) {
        const gotHole = gotTee?.holes.find((hole) => hole.number === expectedHole.number);
        tally("pars", gotHole?.par, expectedHole.par);
        tally("yardages", gotHole ? (gotHole.yardage ?? null) : undefined, expectedHole.yardage);
        tally(
          "indexes",
          gotHole ? (gotHole.strokeIndex ?? null) : undefined,
          expectedHole.strokeIndex,
        );
      }
    }
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
      yardages: tallies.yardages.errors,
      indexes: tallies.indexes.errors,
      pars: tallies.pars.errors,
      names: tallies.names.errors,
    },
  };
}
