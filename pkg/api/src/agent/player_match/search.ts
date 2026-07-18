import { inArray, like, or } from "drizzle-orm";
import type { getDb } from "../../../db";
import { nickname, user } from "../../../schema";
import type { PlayerSearch, PlayerSearchResult } from "./agent";

const MAX_RESULTS = 8;

// Production PlayerSearch: SQLite LIKE is case-insensitive for ASCII, which
// gives the ILIKE semantics the agent is prompted for. The query comes from
// the model, so stray %/_ wildcards only over-match — harmless here.
export function playerSearchFromDb(db: ReturnType<typeof getDb>): PlayerSearch {
  return async (query) => {
    const pattern = `%${query}%`;
    const userHits = await db
      .select({ id: user.id })
      .from(user)
      .where(or(like(user.name, pattern), like(user.email, pattern)))
      .limit(MAX_RESULTS);
    const nicknameHits = await db
      .select({ id: nickname.userId })
      .from(nickname)
      .where(like(nickname.nickname, pattern))
      .limit(MAX_RESULTS);

    const ids = [...new Set([...userHits, ...nicknameHits].map((hit) => hit.id))].slice(
      0,
      MAX_RESULTS,
    );
    if (ids.length === 0) return [];

    const rows = await db.query.user.findMany({
      where: inArray(user.id, ids),
      with: { nicknames: true },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      nicknames: row.nicknames.map((entry) => entry.nickname),
    }));
  };
}

// Eval PlayerSearch: the same case-insensitive substring semantics over an
// in-memory roster, so evals run in plain Bun with no database.
export function playerSearchFromRoster(roster: PlayerSearchResult[]): PlayerSearch {
  return (query) => {
    const needle = query.toLowerCase();
    return Promise.resolve(
      roster
        .filter(
          (player) =>
            (player.name ?? "").toLowerCase().includes(needle) ||
            (player.email ?? "").toLowerCase().includes(needle) ||
            player.nicknames.some((entry) => entry.toLowerCase().includes(needle)),
        )
        .slice(0, MAX_RESULTS),
    );
  };
}
