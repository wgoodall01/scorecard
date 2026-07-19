import type { CourseProposalSchema, ProposalSetSchema, ProposalTeeSchema } from "../schema";

// A 0–1 grade of one research proposal against a reviewed label, plus raw error
// counts by category:
//   - mapping: the reconciliation — usgaCourseId, usgaCourseNine, usgaTeeId
//              (matching a nine/tee to the right USGA record is the whole job)
//   - ratings: per-tee 9-hole courseRating / slopeRating
//   - layout:  per-hole par / yardage (copied from metadata, should be exact)
//   - attrs:   names, gender, type
export type ScoreResult = {
  overall: number;
  errors: { mapping: number; ratings: number; layout: number; attrs: number };
};

const WEIGHTS = { mapping: 3, ratings: 2, layout: 1, attrs: 1 } as const;
type Category = keyof typeof WEIGHTS;

function caseFolded(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function matchSets(
  got: CourseProposalSchema,
  expected: CourseProposalSchema,
): (ProposalSetSchema | undefined)[] {
  const remaining = [...got.sets];
  return expected.sets.map((expectedSet) => {
    const index = remaining.findIndex(
      (gotSet) => caseFolded(gotSet.name) === caseFolded(expectedSet.name),
    );
    if (index === -1) return undefined;
    return remaining.splice(index, 1)[0];
  });
}

function matchTee(
  gotSet: ProposalSetSchema | undefined,
  expectedTee: ProposalTeeSchema,
): ProposalTeeSchema | undefined {
  // Match on name AND gender — a nine can carry both a men's and a women's
  // variant of the same-named tee (distinct rows), and they must grade apart.
  return gotSet?.tees.find(
    (tee) =>
      caseFolded(tee.name) === caseFolded(expectedTee.name) &&
      (tee.gender ?? null) === (expectedTee.gender ?? null),
  );
}

// Graded against every field the EXPECTED label contains; a set/tee/hole
// missing from the output counts its expected cells as errors.
export function score(got: CourseProposalSchema, expected: CourseProposalSchema): ScoreResult {
  const tallies: Record<Category, { errors: number; total: number }> = {
    mapping: { errors: 0, total: 0 },
    ratings: { errors: 0, total: 0 },
    layout: { errors: 0, total: 0 },
    attrs: { errors: 0, total: 0 },
  };
  function tally(category: Category, gotValue: unknown, expectedValue: unknown) {
    tallies[category].total += 1;
    if (gotValue !== expectedValue) tallies[category].errors += 1;
  }

  tally("attrs", caseFolded(got.name), caseFolded(expected.name));
  tally("mapping", got.ncrdbFacilityId, expected.ncrdbFacilityId);

  const matchedSets = matchSets(got, expected);
  expected.sets.forEach((expectedSet, setIndex) => {
    const gotSet = matchedSets[setIndex];
    tally("attrs", caseFolded(gotSet?.name), caseFolded(expectedSet.name));
    tally("mapping", gotSet?.usgaCourseId ?? null, expectedSet.usgaCourseId ?? null);
    tally("mapping", gotSet?.usgaCourseNine ?? null, expectedSet.usgaCourseNine ?? null);

    for (const expectedTee of expectedSet.tees) {
      const gotTee = matchTee(gotSet, expectedTee);
      tally("attrs", caseFolded(gotTee?.name), caseFolded(expectedTee.name));
      tally("attrs", gotTee?.gender ?? null, expectedTee.gender ?? null);
      tally("attrs", gotTee?.type ?? null, expectedTee.type ?? null);
      tally("mapping", gotTee?.usgaTeeId ?? null, expectedTee.usgaTeeId ?? null);
      tally("ratings", gotTee?.courseRating ?? null, expectedTee.courseRating ?? null);
      tally("ratings", gotTee?.slopeRating ?? null, expectedTee.slopeRating ?? null);

      for (const expectedHole of expectedTee.holes) {
        const gotHole = gotTee?.holes.find((hole) => hole.number === expectedHole.number);
        tally("layout", gotHole?.par, expectedHole.par);
        tally("layout", gotHole ? (gotHole.yardage ?? null) : undefined, expectedHole.yardage);
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
      mapping: tallies.mapping.errors,
      ratings: tallies.ratings.errors,
      layout: tallies.layout.errors,
      attrs: tallies.attrs.errors,
    },
  };
}
