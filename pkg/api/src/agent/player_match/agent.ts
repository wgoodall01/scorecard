import { tool } from "ai";
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

const SYSTEM = `You match player names handwritten on a golf scorecard to registered players in a database.

The handwritten names may be full names, first names, last names, initials (e.g. "J. Smith" or "WG"), nicknames, or misspellings.

Use the searchPlayers tool as many times as you need. It does a case-insensitive substring search over player names, emails, and nicknames — so search with short fragments: a last name, a first name, a nickname guess, or even a single letter to list candidates. For initials like "WG", search each initial and look for a player whose first and last name start with those letters. For misspellings, try fragments that survive the typo (e.g. "smit" for "Smtih") or single letters, then compare candidates by similarity.

The searches are independent of each other, so batch them: issue ALL the searches you currently want as parallel searchPlayers calls in a single turn (e.g. open with one search per written name at once), rather than one search per turn. Follow up with another parallel batch only where the results leave a name unresolved.

Matching rules:
- Only return a userId you saw in a searchPlayers result.
- Match a player only when they are clearly the best fit. If two registered players could both plausibly be the written name (e.g. "J. Smith" when both John Smith and Jane Smith exist), return null for that name — a wrong match is worse than no match.
- If nobody plausibly matches, return null for that name.

When you are done, call the answer tool with exactly one entry per input name, in the same order.`;

// Chosen by the eval sweep (2026-07-17, 5 models × 13 cases): the only model
// with perfect recall — every gpt-5.4-mini/nano variant (low+medium) missed
// the bare-initials "DH" case, though all held precision at 1.0. Also the
// cheapest of the field, and the same model card_scores already uses.
const DEFAULT_MODEL: ModelSpec = "google/gemini-3.5-flash@low";

export async function matchPlayers({
  names,
  search,
  resolver,
  model = DEFAULT_MODEL,
}: {
  names: string[];
  search: PlayerSearch;
  resolver: ModelResolver;
  model?: ModelSpec;
}): Promise<PlayerMatchSchema[]> {
  if (names.length === 0) return [];

  // Every id the model actually saw in a tool result; anything else in the
  // answer is a hallucination and gets nulled out.
  const seenIds = new Set<string>();

  const searchPlayers = tool({
    description:
      "Case-insensitive substring search over registered players' names, emails, and " +
      "nicknames. Returns up to a handful of candidates with their ids.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
    }),
    execute: async ({ query }) => {
      const players = await search(query);
      for (const player of players) seenIds.add(player.id);
      return { players };
    },
  });

  const answer = await runAnswerAgent({
    resolver,
    model,
    system: SYSTEM,
    prompt: `Match these scorecard names to registered players:\n${JSON.stringify(names)}`,
    tools: { searchPlayers },
    answerSchema: PlayerMatchAnswer,
    answerDescription:
      "Submit the final matches: one entry per input name, in input order, with the " +
      "matched player's id or null.",
  });

  // Reconcile against the input: positional when the model returned one entry
  // per name (the instructed shape), by-name otherwise, null as the fallback.
  const byName = new Map(answer.matches.map((match) => [match.name, match.userId]));
  return names.map((name, index) => {
    const positional =
      answer.matches.length === names.length ? answer.matches[index]?.userId : undefined;
    const userId = positional !== undefined ? positional : (byName.get(name) ?? null);
    return { name, userId: userId !== null && seenIds.has(userId) ? userId : null };
  });
}
