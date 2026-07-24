import { lt } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { encodeBase64 } from "./base64";

// Keyset ("cursor") pagination, uniform across every list endpoint.
//
// The wire shape is `?after=<cursor>&limit=<n>` (both optional — no `after` is
// the first page) and the response body IS the `Page`: the records plus the
// cursor to hand back as `after` for the next one, null once the list is
// exhausted. Routes never touch the cursor themselves; they spread
// `PageRef.shape` into their query schema and run their query through
// `loadPageById`.
//
// A cursor is base64url of `v0:<column>:<direction>:<value>`, opaque to
// clients. Only `id` descending exists today — primary keys are uuidv7, which
// sort by creation time, so descending id is newest-first — but the column and
// direction ride in the payload so a name- or date-keyed sort is additive
// rather than a new cursor format.

const CURSOR_VERSION = "v0";

// The one sort we implement so far. `d` = descending, `a` = ascending.
const ID_DESC = { column: "id", direction: "d" } as const;

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export type CursorParts = { column: string; direction: "a" | "d"; value: string };

function toBase64Url(text: string) {
  return encodeBase64(new TextEncoder().encode(text))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeCursor(parts: CursorParts): string {
  return toBase64Url(`${CURSOR_VERSION}:${parts.column}:${parts.direction}:${parts.value}`);
}

// The cursor's parts, or null when it isn't a cursor we minted. The value may
// itself contain colons (a future composite key), so only the first three
// segments are structural.
export function decodeCursor(cursor: string): CursorParts | null {
  const decoded = fromBase64Url(cursor);
  if (decoded === null) return null;
  const [version, column, direction, ...rest] = decoded.split(":");
  if (version !== CURSOR_VERSION) return null;
  if (direction !== "a" && direction !== "d") return null;
  const value = rest.join(":");
  if (!column || !value) return null;
  return { column, direction, value };
}

export function idCursor(id: string): string {
  return encodeCursor({ ...ID_DESC, value: id });
}

// Only reverse-id cursors are accepted for now; a cursor naming another sort is
// as invalid as a garbled one until that sort exists.
function isSupportedCursor(value: string) {
  const parts = decodeCursor(value);
  return parts?.column === ID_DESC.column && parts.direction === ID_DESC.direction;
}

export const Cursor = z.string().refine(isSupportedCursor, "Invalid cursor");
export type CursorSchema = z.infer<typeof Cursor>;

// `?after=<cursor>&limit=<n>` — spread `PageRef.shape` into a route's own query
// schema to make it paginated. Both are optional (an absent or empty `after` is
// the first page, an absent limit is `PAGE_LIMIT_DEFAULT`); `loadPageById`
// resolves them. Keep the field types plain string/number-optional — that's
// what makes Hono's RPC client type them as optional query params.
export const PageRef = z.object({
  after: z
    .string()
    .refine((value) => value === "" || isSupportedCursor(value), "Invalid cursor")
    .optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
});
export type PageRefSchema = z.infer<typeof PageRef>;

export type Page<TRecord> = { records: TRecord[]; next: CursorSchema | null };

// `WHERE id < :after` for a descending-id page — undefined (no bound) on the
// first page, so it drops out of the surrounding `and(...)`.
export function afterIdWhere(column: SQLiteColumn, afterId: string | null) {
  return afterId === null ? undefined : lt(column, afterId);
}

// Run one page of a descending-id list. `load` must apply `afterIdWhere`,
// order by id DESC, and honor `limit` — it's handed one row more than the
// caller asked for, which is how "is there another page?" is answered without
// a second count query.
export async function loadPageById<TRecord extends { id: string }>(
  ref: PageRefSchema,
  load: (bound: { afterId: string | null; limit: number }) => Promise<TRecord[]>,
): Promise<Page<TRecord>> {
  const limit = ref.limit ?? PAGE_LIMIT_DEFAULT;
  const afterId = ref.after ? (decodeCursor(ref.after)?.value ?? null) : null;
  const rows = await load({ afterId, limit: limit + 1 });
  const records = rows.slice(0, limit);
  const last = records.at(-1);
  return {
    records,
    next: rows.length > limit && last !== undefined ? idCursor(last.id) : null,
  };
}
