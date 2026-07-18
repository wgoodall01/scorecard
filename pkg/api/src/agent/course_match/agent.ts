import { tool } from "ai";
import { z } from "zod";
import type { ModelResolver, ModelSpec } from "../../model";
import { runAnswerAgent } from "../answer_tool";
import { CourseMatchAnswer, type CourseMatchAnswerSchema } from "./schema";

// What the search tool returns to the model for each candidate course —
// always the whole course with ALL of its sets, so the model can match a
// course from its set names alone and pick the right set by its hole range
// (`holes` is a "1-9"-style label derived from the set's hole numbers;
// null when the set has no holes recorded yet).
export type CourseSearchResult = {
  id: string;
  name: string;
  location: string | null;
  sets: { id: string; name: string; holes: string | null }[];
};

// Injected search: production wires an SQL ILIKE search over course AND set
// names (see search.ts); the eval wires the same semantics in memory.
export type CourseSearch = (query: string) => Promise<CourseSearchResult[]>;

// Every course set in the database with its hole/par layout, for the exact
// par-sequence phase below. Injected like the search (see search.ts).
export type CourseSetPars = {
  courseId: string;
  courseSetId: string;
  holes: { number: number; par: number }[];
};
export type CourseSetParsList = () => Promise<CourseSetPars[]>;

// One nine as extracted from the card: its printed name (if any) and its
// printed holes. Hole numbers 1–9 imply a front nine, 10–18 a back nine, and
// the (number, par) sequence is a fingerprint the exact phase matches first.
export type ExtractedNine = {
  name: string | null;
  holes: { number: number; par: number }[];
};

const SYSTEM = `You match a golf course and its nines ("course sets"), as read off a photographed scorecard, to known courses in a database.

You get the course name as written on the card (often missing or partial) and each played nine with its printed name (often missing), hole numbers, and pars.

Use the searchCourses tool as many times as you need. It does a case-insensitive substring search over course names AND set names, and returns whole courses with all of their sets — so a distinctive nine name alone (e.g. "White Oak") can find the course even when the card has no course name. Search with SHORT fragments — a full written name like "BLUE SPRUCE" matches nothing if the database calls the set just "Blue", so always also search each individual word ("blue", "spruce"): cards routinely embellish nine names beyond what the database stores.

The searches are independent of each other, so batch them: issue ALL the searches you currently want as parallel searchCourses calls in a single turn (e.g. the course-name fragments and every nine-name word at once), rather than one search per turn.

Matching rules:
- Only return a courseId or courseSetId you saw in a searchCourses result.
- The matched sets must belong to the matched course.
- Use hole numbers to disambiguate: each returned set carries its hole range (e.g. "1-9" or "10-18"), so a nine with no printed name can still be matched by its hole numbers once the course is identified.
- The pars come from photo OCR and may contain a misread digit — do not reject an otherwise-good name/hole-range match because a par or two disagrees.
- Match only when clearly the best fit. Generic nine names alone (e.g. just "Front Nine") match many courses — if the course itself can't be pinned down, return null rather than guessing.
- Decide within your step budget: once the searches point to one clear candidate (or clearly nothing), stop searching and call answer.

When you are done, call the answer tool with the matched course and exactly one entry per input nine, in the same order.`;

// Chosen by the eval sweep (2026-07-17, post-exact-phase fixtures): the only
// LLM-fallback case that separates models is matching embellished nine names
// with misread pars ("WHITE OAK" → set "White") — gpt-5.4-nano aces it at low
// effort while gemini-3.5-flash abstains even at medium, and gpt-5.4-mini
// guessed on the ambiguous-nine case (precision 0.905). Most cards never
// reach the LLM at all thanks to the exact par-sequence phase.
const DEFAULT_MODEL: ModelSpec = "openai/gpt-5.4-nano@low";

// "1:4,2:5,…" — the exact-match fingerprint of a hole layout.
function parSignature(holes: { number: number; par: number }[]): string {
  return [...holes]
    .sort((a, b) => a.number - b.number)
    .map((hole) => `${hole.number}:${hole.par}`)
    .join(",");
}

// Phase 1 (no LLM): a nine whose printed (hole, par) sequence matches exactly
// ONE course set in the database is that set — cards often embellish nine
// names ("BLUE SPRUCE" for a set stored as "Blue"), but the par layout is
// literal. Matches must all land on a single course (a card is one course);
// conflicting or duplicated exact matches are discarded as ambiguous.
async function matchByParSequence(
  nines: ExtractedNine[],
  listSetPars: CourseSetParsList,
): Promise<(CourseSetPars | null)[]> {
  const bySignature = new Map<string, CourseSetPars[]>();
  for (const set of await listSetPars()) {
    const signature = parSignature(set.holes);
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), set]);
  }

  const matches = nines.map((nine) => {
    if (nine.holes.length === 0) return null;
    const candidates = bySignature.get(parSignature(nine.holes)) ?? [];
    return candidates.length === 1 ? candidates[0] : null;
  });

  const courses = new Set(
    matches.filter((match): match is CourseSetPars => match !== null).map((m) => m.courseId),
  );
  if (courses.size > 1) return nines.map(() => null);

  // Two nines resolving to the SAME set is ambiguity, not a match.
  return matches.map((match, index) =>
    match !== null &&
    matches.some(
      (other, otherIndex) => otherIndex !== index && other?.courseSetId === match.courseSetId,
    )
      ? null
      : match,
  );
}

export async function matchCourseSets({
  courseName,
  nines,
  search,
  listSetPars,
  resolver,
  model = DEFAULT_MODEL,
}: {
  courseName: string | null;
  nines: ExtractedNine[];
  search: CourseSearch;
  listSetPars: CourseSetParsList;
  resolver: ModelResolver;
  model?: ModelSpec;
}): Promise<CourseMatchAnswerSchema> {
  if (nines.length === 0 && courseName === null) return { courseId: null, sets: [] };

  const exact = await matchByParSequence(nines, listSetPars);
  const exactCourseId = exact.find((match) => match !== null)?.courseId ?? null;
  if (exact.every((match) => match !== null)) {
    return {
      courseId: exactCourseId,
      sets: nines.map((nine, index) => ({
        nineName: nine.name,
        courseSetId: exact[index]?.courseSetId ?? null,
      })),
    };
  }

  // Phase 2: agentic search for whatever the exact phase couldn't pin down.
  // Track everything the model actually saw so hallucinated ids can be
  // nulled, and so set↔course consistency can be enforced after the fact.
  const seenCourses = new Set<string>();
  const setCourse = new Map<string, string>();

  const searchCourses = tool({
    description:
      "Case-insensitive substring search over golf course names AND their set/nine " +
      "names. Returns matching courses with all of their sets.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
    }),
    execute: async ({ query }) => {
      const courses = await search(query);
      for (const found of courses) {
        seenCourses.add(found.id);
        for (const set of found.sets) setCourse.set(set.id, found.id);
      }
      return { courses };
    },
  });

  const nineDescriptions = nines.map((nine) => ({
    name: nine.name,
    holes:
      nine.holes.length > 0
        ? `${Math.min(...nine.holes.map((h) => h.number))}-${Math.max(...nine.holes.map((h) => h.number))}`
        : null,
    pars:
      nine.holes.length > 0
        ? [...nine.holes]
            .sort((a, b) => a.number - b.number)
            .map((hole) => hole.par)
            .join(",")
        : null,
  }));
  const answer = await runAnswerAgent({
    resolver,
    model,
    system: SYSTEM,
    prompt:
      `Course name as written on the card: ${JSON.stringify(courseName)}\n` +
      `Nines played (in order): ${JSON.stringify(nineDescriptions)}`,
    tools: { searchCourses },
    answerSchema: CourseMatchAnswer,
    answerDescription:
      "Submit the final match: the course id (or null) and one entry per input nine, in " +
      "input order, each with the matched course set's id or null.",
  });

  // Reconcile the LLM answer against the input (positional when shaped as
  // instructed, by-name otherwise) and drop hallucinated ids; exact-phase
  // matches always win over the LLM's answer for their nine.
  const byName = new Map(answer.sets.map((set) => [set.nineName, set.courseSetId]));
  const sets = nines.map((nine, index) => {
    const exactMatch = exact[index];
    if (exactMatch !== null) {
      return { nineName: nine.name, courseSetId: exactMatch.courseSetId };
    }
    const positional =
      answer.sets.length === nines.length ? answer.sets[index]?.courseSetId : undefined;
    const rawSetId = positional !== undefined ? positional : (byName.get(nine.name) ?? null);
    return {
      nineName: nine.name,
      courseSetId: rawSetId !== null && setCourse.has(rawSetId) ? rawSetId : null,
    };
  });

  // Final course: the exact phase's course when it found one, else the LLM's
  // (validated), else inferred from the LLM's matched sets. Then force
  // set↔course consistency (exact-phase set ids registered so they survive).
  for (const match of exact) {
    if (match !== null) setCourse.set(match.courseSetId, match.courseId);
  }
  let courseId =
    exactCourseId ??
    (answer.courseId !== null && seenCourses.has(answer.courseId) ? answer.courseId : null);
  const matchedCourseIds = new Set(
    sets
      .map((set) => (set.courseSetId ? setCourse.get(set.courseSetId) : undefined))
      .filter((id): id is string => id !== undefined),
  );
  if (courseId === null && matchedCourseIds.size === 1) {
    courseId = [...matchedCourseIds][0];
  }
  for (const set of sets) {
    if (set.courseSetId && setCourse.get(set.courseSetId) !== courseId) {
      set.courseSetId = null;
    }
  }

  return { courseId, sets };
}
