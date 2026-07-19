import { tool, type UserContent } from "ai";
import { z } from "zod";
import type { ModelResolver, ModelSpec } from "../../model";
import { runAnswerAgent } from "../answer_tool";
import { PlayerMatchAnswer, type PlayerMatchSchema } from "./schema";

// What the search tool returns to the model for each candidate player.
export type PlayerSearchResult = {
  id: string;
  name: string | null;
  email: string | null;
  nicknames: string[];
};

// Injected search: production wires an SQL ILIKE search over the user table
// (see search.ts); the eval wires the same semantics over an in-memory roster.
export type PlayerSearch = (query: string) => Promise<PlayerSearchResult[]>;

// One written name to resolve, with everything the extraction learned about
// it: the best reading, the model's alternative readings of the same scrawl,
// and where it appeared on the card (e.g. "Player 2 on Blue Spruce"). The
// `name` is the dedup key — two written strings for one person ("AJM"/"AJ")
// stay separate entries and are reconciled downstream in review.
export type PlayerQuery = {
  name: string;
  guesses: string[];
  locations: string[];
  // A cropped image of the handwritten name/initials, so the model can read
  // an illegible scrawl directly instead of trusting the text reading. Optional
  // — evals and any capture without a usable bounding box just omit it.
  thumbnail?: { bytes: ArrayBuffer; mediaType: string } | null;
};

const SYSTEM = `You match player names handwritten on a golf scorecard to registered players in a database.

The handwritten names may be full names, first names, last names, initials (e.g. "J. Smith" or "WG"), nicknames, or misspellings — and the reading may be uncertain, so each name comes with the best reading plus alternative readings of the same scrawl and where it appeared on the card. For many names you are ALSO given a cropped image of the actual handwriting, labeled with the name it belongs to — read it yourself to settle an ambiguous or misread name; trust what you see in the crop over the text readings when they disagree.

For every name you are ALSO given a list of candidate players already looked up for you (by the name, its alternative readings, each word, and each initial). Often the right match — or a confident "nobody" — is decidable from these candidates alone, so answer directly.

But do NOT answer null just because a name's candidate list is empty or nothing there fits — that usually means the reading is off, so search first. Use the searchPlayers tool: it takes a LIST of queries and runs them all at once (case-insensitive substring search over player names, emails, and nicknames), so batch every query for every still-unresolved name into a single call — a last name, a first name, a nickname guess, the fragments that survive a typo (e.g. "smit" for "Smtih"), or single letters of initials. Only answer null once a real search has come up empty.

Matching rules:
- Only return a userId you saw in a candidate list or a searchPlayers result.
- Match a player only when they are clearly the best fit. If two registered players could both plausibly be the written name (e.g. "J. Smith" when both John Smith and Jane Smith exist), return null for that name — a wrong match is worse than no match.
- The alternative readings and card location are hints for disambiguation, not separate people to match.
- If nobody plausibly matches, return null for that name.

When you are done, call the answer tool with exactly one entry per input name, in the same order.`;

// Chosen by the eval sweep (2026-07-17, 5 models × 13 cases): the only model
// with perfect recall — every gpt-5.4-mini/nano variant (low+medium) missed
// the bare-initials "DH" case, though all held precision at 1.0. Also the
// cheapest of the field, and the same model card_scores already uses.
const DEFAULT_MODEL: ModelSpec = "google/gemini-3.5-flash@low";

// The matcher is prompted with prefetched candidates, so it usually answers in
// one turn; a couple of extra steps let it batch-search when the candidates
// fall short. Kept low to bound latency (and, for gemini, to avoid dribbling
// reasoning across many replayed turns).
const MAX_MATCH_STEPS = 4;

// The distinct written strings for one name — the best reading plus every
// alternative reading — used for the exact-match fast path (equality only).
function queryStrings(entry: PlayerQuery): string[] {
  return [...new Set([entry.name, ...entry.guesses].map((s) => s.trim()).filter(Boolean))];
}

// The DB-search fragments to prefetch for one written name. Beyond the whole
// strings, this splits on whitespace (so "Gregg Nolan" surfaces "Gregory
// Nolan" via the unique last name, and a misspelled first name doesn't sink
// the search) and, for an initials-like token ("WG", "KP"), each letter (so
// "KP" surfaces "Kevin Park" even when it isn't a stored nickname) — the
// fragment probing the agent used to do turn-by-turn, done up front.
function prefetchQueriesFor(entry: PlayerQuery): string[] {
  const out = new Set<string>();
  for (const raw of [entry.name, ...entry.guesses]) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    out.add(trimmed);
    for (const word of trimmed.split(/\s+/).filter(Boolean)) {
      out.add(word);
      const letters = word.replace(/[^A-Za-z]/g, "");
      if (letters.length >= 2 && letters.length <= 4 && letters === letters.toUpperCase()) {
        for (const letter of letters) out.add(letter);
      }
    }
  }
  return [...out];
}

// A candidate is a confident exact match for a written name when the name (or
// one of its alternative readings) equals the candidate's full name or a
// nickname, case-insensitively — the safe, no-LLM resolution.
function isExactMatch(candidate: PlayerSearchResult, queries: string[]): boolean {
  const haystack = [candidate.name, ...candidate.nicknames]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.toLowerCase());
  return queries.some((q) => haystack.includes(q.toLowerCase()));
}

export async function matchPlayers({
  players,
  search,
  resolver,
  model = DEFAULT_MODEL,
}: {
  players: PlayerQuery[];
  search: PlayerSearch;
  resolver: ModelResolver;
  model?: ModelSpec;
}): Promise<PlayerMatchSchema[]> {
  if (players.length === 0) return [];

  // Every id the model may legitimately answer with — seeded from the
  // prefetch, extended by any tool searches. Anything else in the answer is a
  // hallucination and gets nulled out.
  const seenIds = new Set<string>();

  // Prefetch: run each name's queries against the DB up front (deduped so a
  // string shared across names hits the DB once), and hand the results to the
  // model so it can usually answer without searching at all.
  const searchCache = new Map<string, PlayerSearchResult[]>();
  const runSearch = async (query: string) => {
    const key = query.toLowerCase();
    const cached = searchCache.get(key);
    if (cached) return cached;
    const results = await search(query);
    searchCache.set(key, results);
    for (const player of results) seenIds.add(player.id);
    return results;
  };

  const prefetched = await Promise.all(
    players.map(async (entry) => {
      const byId = new Map<string, PlayerSearchResult>();
      for (const results of await Promise.all(prefetchQueriesFor(entry).map(runSearch))) {
        for (const candidate of results) byId.set(candidate.id, candidate);
      }
      return { entry, exactQueries: queryStrings(entry), candidates: [...byId.values()] };
    }),
  );

  // Deterministic fast path: a written name whose exact reading uniquely
  // identifies one candidate is that candidate, with no LLM at all. A name
  // with zero candidates resolves to null. If every name resolves this way
  // and no two names claim the same golfer (that aliasing case needs
  // judgment), we're done in 0 turns.
  const exactById = prefetched.map(({ candidates, exactQueries }) => {
    const hits = candidates.filter((candidate) => isExactMatch(candidate, exactQueries));
    return hits.length === 1 ? hits[0].id : null;
  });
  const claimCounts = new Map<string, number>();
  for (const id of exactById) if (id) claimCounts.set(id, (claimCounts.get(id) ?? 0) + 1);
  const everyNameSettled = prefetched.every(
    ({ candidates }, index) => exactById[index] !== null || candidates.length === 0,
  );
  const noContestedClaims = [...claimCounts.values()].every((count) => count === 1);
  if (everyNameSettled && noContestedClaims) {
    return players.map((entry, index) => ({ name: entry.name, userId: exactById[index] }));
  }

  const searchPlayers = tool({
    description:
      "Case-insensitive substring search over registered players' names, emails, and " +
      "nicknames. Pass MANY queries at once; each returns up to a handful of candidates.",
    inputSchema: z.object({
      queries: z
        .array(z.string().min(1))
        .min(1)
        .describe("Substrings to search for (case-insensitive), run as a batch."),
    }),
    execute: async ({ queries }) => {
      const results = await Promise.all(
        queries.map(async (query) => ({ query, players: await runSearch(query) })),
      );
      return { results };
    },
  });

  const promptData = prefetched.map(({ entry, candidates }) => ({
    name: entry.name,
    alternativeReadings: entry.guesses,
    seenAt: entry.locations,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      email: candidate.email,
      nicknames: candidate.nicknames,
    })),
  }));

  // Attach each name's handwriting crop as a labeled image part, so the model
  // can read an ambiguous scrawl itself. Falls back to a plain text prompt
  // when nothing was cropped (evals, or no usable bounding boxes).
  const introText =
    "Match these scorecard names to registered players. Each entry lists the best reading, " +
    "alternative readings, where it appeared on the card, and candidate players already " +
    `looked up for you:\n${JSON.stringify(promptData, null, 2)}`;
  const imageParts: UserContent = prefetched.flatMap(({ entry }) =>
    entry.thumbnail
      ? [
          { type: "text", text: `Handwriting crop for "${entry.name}":` },
          { type: "image", image: entry.thumbnail.bytes, mediaType: entry.thumbnail.mediaType },
        ]
      : [],
  );
  const prompt: string | UserContent =
    imageParts.length > 0 ? [{ type: "text", text: introText }, ...imageParts] : introText;

  const answer = await runAnswerAgent({
    resolver,
    model,
    maxSteps: MAX_MATCH_STEPS,
    system: SYSTEM,
    prompt,
    tools: { searchPlayers },
    answerSchema: PlayerMatchAnswer,
    answerDescription:
      "Submit the final matches: one entry per input name, in input order, with the " +
      "matched player's id or null.",
  });

  // Reconcile against the input: positional when the model returned one entry
  // per name (the instructed shape), by-name otherwise, null as the fallback.
  const byName = new Map(answer.matches.map((match) => [match.name, match.userId]));
  return players.map((entry, index) => {
    const positional =
      answer.matches.length === players.length ? answer.matches[index]?.userId : undefined;
    const userId = positional !== undefined ? positional : (byName.get(entry.name) ?? null);
    return { name: entry.name, userId: userId !== null && seenIds.has(userId) ? userId : null };
  });
}
