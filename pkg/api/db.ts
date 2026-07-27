import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

// The drizzle client, for helpers that take a db rather than a binding.
export type Db = ReturnType<typeof getDb>;
