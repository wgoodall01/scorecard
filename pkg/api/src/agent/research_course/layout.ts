import { z } from "zod";
import type { CardMetadataSchema } from "../card_metadata/schema";
import type {
  GolfCourseApiCourseSchema,
  GolfCourseApiTeeBoxSchema,
} from "../../golfcourseapi/schema";

// CourseLayout is the source-agnostic shape research_course reconciles against
// the USGA mirror: a course's printed LAYOUT — its nines, their tee positions,
// and each tee's per-hole par / yardage / stroke index.
//
// There are two producers, and a run may pass BOTH:
//
//   - layoutFromGolfCourseApi — the primary source. Authoritative pars,
//     yardages, and stroke indexes, with the tee's gender already known, so the
//     agent has nothing to guess. What it CAN'T supply is a nine's printed name:
//     GolfCourseAPI names a nine after its tee color ("White"), never the name
//     on the card ("White Oak").
//   - layoutFromCardMetadata — the gap-filler. A scorecard photo, read by the
//     card_metadata vision agent. Only requested when the GolfCourseAPI feed is
//     missing or incomplete (see layoutGaps), and its main contribution when
//     both are present is those printed nine names.
//
// Holes are numbered as the layout presents them (1–9 for a front nine, 10–18
// for a back), which is how the app derives a nine's front/back disposition —
// the schema stores no explicit flag.

export const LayoutHole = z.object({
  number: z.number().int().min(1).max(18),
  par: z.number().int(),
  yardage: z.number().int().nullable(),
  // The printed stroke index (1 = the hole that gets a handicap stroke first).
  // Ranks hole difficulty for the net-double-bogey cap in src/handicap.ts.
  strokeIndex: z.number().int().nullable(),
});
export type LayoutHoleSchema = z.infer<typeof LayoutHole>;

export const LayoutTee = z.object({
  name: z.string().nullable(),
  // The rated gender when the source knows it (GolfCourseAPI does), null when
  // it doesn't (a scorecard prints one yardage row per tee, ungendered).
  gender: z.enum(["m", "f"]).nullable(),
  holes: z.array(LayoutHole),
});
export type LayoutTeeSchema = z.infer<typeof LayoutTee>;

export const LayoutNine = z.object({
  name: z.string().nullable(),
  tees: z.array(LayoutTee),
});
export type LayoutNineSchema = z.infer<typeof LayoutNine>;

export const CourseLayout = z.object({
  source: z.enum(["golfcourseapi", "scorecard"]),
  // Human provenance for the prompt, e.g. 'GolfCourseAPI, club "Buck Hill Falls
  // Golf Club" (courses White/Blue, Blue/Red, Red/White)'.
  origin: z.string(),
  nines: z.array(LayoutNine),
});
export type CourseLayoutSchema = z.infer<typeof CourseLayout>;

// ---------------------------------------------------------------------------
// Scorecard photo → layout
// ---------------------------------------------------------------------------

export function layoutFromCardMetadata(metadata: CardMetadataSchema): CourseLayoutSchema {
  return {
    source: "scorecard",
    origin: "A photo of the course's printed scorecard",
    nines: metadata.nines.map((nine) => ({
      name: nine.name,
      tees: nine.tees.map((tee) => ({
        // A card prints one yardage row per tee position, with no indication of
        // which gender each is rated for — so gender stays unknown here and the
        // agent resolves it from the USGA records.
        gender: null,
        name: tee.name,
        holes: tee.holes.map((hole) => ({
          number: hole.number,
          par: hole.par,
          yardage: hole.yardage,
          strokeIndex: hole.strokeIndex,
        })),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// GolfCourseAPI → layout
// ---------------------------------------------------------------------------

// GolfCourseAPI models every rated layout as an 18, so a multi-nine club comes
// back as one entry per nine-COMBINATION ("White/Blue" = the White nine then
// the Blue nine). Each entry therefore contributes two nine "occurrences", and
// the same physical nine occurs in several combinations — Buck Hill's three
// nines span three combinations, each nine appearing once as a front half and
// once as a back half.
type NineOccurrence = {
  name: string | null;
  // 1 for a front half, 10 for a back half.
  firstNumber: number;
  tees: LayoutTeeSchema[];
};

const HOLES_PER_NINE = 9;

// "White/Blue" → ["White", "Blue"]. A combination name joins its two nines with
// a slash; anything else is a single unsplit name.
function splitCombinationName(courseName: string | null): string[] {
  if (courseName === null) return [];
  const parts = courseName
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 2 ? parts : [];
}

// One tee's slice of a nine, renumbered onto that nine's hole numbers. Returns
// null when the tee doesn't cover the slice or is missing a par — a tee we
// can't represent faithfully is dropped rather than half-filled (par is
// NOT NULL on the hole table).
function teeSlice(
  tee: GolfCourseApiTeeBoxSchema,
  gender: "m" | "f",
  offset: number,
  firstNumber: number,
): LayoutTeeSchema | null {
  const slice = tee.holes.slice(offset, offset + HOLES_PER_NINE);
  if (slice.length < HOLES_PER_NINE) return null;
  if (slice.some((hole) => hole.par === null)) return null;
  return {
    name: tee.tee_name,
    gender,
    holes: slice.map((hole, index) => ({
      number: firstNumber + index,
      par: hole.par as number,
      yardage: hole.yardage,
      strokeIndex: hole.handicap,
    })),
  };
}

function teeKey(tee: LayoutTeeSchema): string {
  return `${(tee.name ?? "").toLowerCase()}/${tee.gender ?? ""}`;
}

/**
 * Fold GolfCourseAPI's nine-combination entries into one layout nine per
 * distinct physical nine.
 *
 * Two things make this more than a slice-in-half:
 *
 *  1. **Numbering.** A nine that appears as a front half is numbered 1–9 and as
 *     a back half 10–18. We keep the FRONT occurrence's numbering when there is
 *     one, which is both what the USGA records do (every rated nine fronts some
 *     combination) and what keeps a club's nines non-overlapping.
 *  2. **Tee coverage.** A club doesn't rate every tee on every combination —
 *     Buck Hill's "Blue/White" combination tee is rated on the White/Blue
 *     course but not on Blue/Red. So a nine's tees are UNIONED across every
 *     combination it appears in, each contribution renumbered onto the nine's
 *     chosen numbering.
 */
export function layoutFromGolfCourseApi(courses: GolfCourseApiCourseSchema[]): CourseLayoutSchema {
  const occurrences: NineOccurrence[] = [];

  for (const course of courses) {
    const genderedTees: { tee: GolfCourseApiTeeBoxSchema; gender: "m" | "f" }[] = [
      ...course.tees.male.map((tee) => ({ tee, gender: "m" as const })),
      ...course.tees.female.map((tee) => ({ tee, gender: "f" as const })),
    ];
    const holeCount = Math.max(0, ...genderedTees.map((entry) => entry.tee.holes.length));
    if (holeCount < HOLES_PER_NINE) continue;

    // An 18 splits into two halves; a 9-hole entry is a single nine.
    const halves = holeCount >= HOLES_PER_NINE * 2 ? 2 : 1;
    const combinationNames = splitCombinationName(course.course_name);
    const names =
      halves === 2
        ? // Unnamed 18s follow the card_metadata convention: "Front"/"Back".
          combinationNames.length === 2
          ? combinationNames
          : ["Front", "Back"]
        : [course.course_name];

    for (let half = 0; half < halves; half++) {
      const offset = half * HOLES_PER_NINE;
      const firstNumber = offset + 1;
      const tees = genderedTees
        .map((entry) => teeSlice(entry.tee, entry.gender, offset, firstNumber))
        .filter((tee): tee is LayoutTeeSchema => tee !== null);
      if (tees.length === 0) continue;
      occurrences.push({ name: names[half] ?? null, firstNumber, tees });
    }
  }

  // Group by nine name. An unnamed occurrence can't be identified across
  // combinations, so it gets a key of its own.
  const groups = new Map<string, NineOccurrence[]>();
  occurrences.forEach((occurrence, index) => {
    const key = occurrence.name === null ? ` unnamed-${index}` : occurrence.name.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(occurrence);
    else groups.set(key, [occurrence]);
  });

  const nines: LayoutNineSchema[] = [];
  for (const group of groups.values()) {
    // Prefer the front-half occurrence's numbering (see the doc comment).
    const canonical = group.reduce((best, entry) =>
      entry.firstNumber < best.firstNumber ? entry : best,
    );
    const numbers = canonical.tees[0]?.holes.map((hole) => hole.number) ?? [];

    // Union the tees across occurrences, canonical first so its holes win, and
    // renumber every contribution onto the canonical numbering.
    const tees = new Map<string, LayoutTeeSchema>();
    for (const occurrence of [canonical, ...group.filter((entry) => entry !== canonical)]) {
      for (const tee of occurrence.tees) {
        const key = teeKey(tee);
        if (tees.has(key)) continue;
        tees.set(key, {
          ...tee,
          holes: tee.holes.map((hole, index) => ({
            ...hole,
            number: numbers[index] ?? hole.number,
          })),
        });
      }
    }

    nines.push({ name: canonical.name, tees: [...tees.values()] });
  }

  const clubNames = [...new Set(courses.map((course) => course.club_name))];
  const courseNames = courses.map((course) => course.course_name ?? String(course.id));
  const origin =
    `GolfCourseAPI, club ${clubNames.map((name) => `"${name}"`).join(" / ")}` +
    (courseNames.length > 0 ? ` (rated layouts: ${courseNames.join(", ")})` : "");

  return { source: "golfcourseapi", origin, nines };
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

// A "blocking" gap means the layout can't stand on its own and a scorecard
// photo is REQUIRED; "advisory" means it's usable but a photo would improve it
// (and the admin can also just fix it in the review editor).
export type LayoutGap = { severity: "blocking" | "advisory"; message: string };

function everyHole(
  layout: CourseLayoutSchema,
  predicate: (hole: LayoutHoleSchema) => boolean,
): boolean {
  return layout.nines.every((nine) => nine.tees.every((tee) => tee.holes.every(predicate)));
}

/**
 * What a layout can't tell us, in words fit for the UI. An empty list means the
 * layout is enough on its own. Drives whether the flow asks for a scorecard
 * photo before running the research agent.
 */
export function layoutGaps(layout: CourseLayoutSchema | null): LayoutGap[] {
  if (layout === null || layout.nines.length === 0) {
    return [
      {
        severity: "blocking",
        message: "we don't have this course's layout — no nines, tees, or pars",
      },
    ];
  }

  const gaps: LayoutGap[] = [];
  const { nines } = layout;

  if (nines.some((nine) => nine.tees.length === 0)) {
    gaps.push({ severity: "blocking", message: "some nines have no tee positions" });
  }
  if (nines.some((nine) => nine.tees.some((tee) => tee.holes.length !== HOLES_PER_NINE))) {
    gaps.push({ severity: "blocking", message: "some nines don't have nine holes" });
  }
  if (nines.some((nine) => nine.tees.some((tee) => tee.name === null))) {
    gaps.push({ severity: "advisory", message: "some tee positions are unnamed" });
  }
  if (everyHole(layout, (hole) => hole.yardage === null)) {
    gaps.push({ severity: "advisory", message: "no yardages" });
  }
  if (everyHole(layout, (hole) => hole.strokeIndex === null)) {
    gaps.push({ severity: "advisory", message: "no stroke indexes (the hole-difficulty ranking)" });
  }
  // GolfCourseAPI names a nine after its tee color, never the name printed on
  // the card — so a multi-nine club reads as "White"/"Blue" rather than
  // "White Oak"/"Blue Spruce". Advisory, not blocking: those ARE the nines'
  // names as far as the USGA is concerned, and the review editor can rename.
  if (layout.source === "golfcourseapi" && nines.length > 1) {
    gaps.push({
      severity: "advisory",
      message: `the nines are named after their tee colors (${nines
        .map((nine) => nine.name ?? "unnamed")
        .join(", ")}) — a scorecard photo would give their printed names`,
    });
  }

  return gaps;
}
