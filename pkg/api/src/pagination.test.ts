import { describe, expect, it } from "vitest";
import {
  Cursor,
  decodeCursor,
  encodeCursor,
  idCursor,
  loadPageById,
  PageRef,
  type Page,
} from "./pagination";

describe("cursors", () => {
  it("round-trips through base64url", () => {
    const cursor = idCursor("0198f0a0-0000-7000-8000-000000000001");
    expect(cursor).not.toContain("=");
    expect(decodeCursor(cursor)).toEqual({
      column: "id",
      direction: "d",
      value: "0198f0a0-0000-7000-8000-000000000001",
    });
  });

  it("keeps colons in the value, for a future composite key", () => {
    expect(
      decodeCursor(encodeCursor({ column: "date", direction: "d", value: "2026-07-24|abc" })),
    ).toEqual({ column: "date", direction: "d", value: "2026-07-24|abc" });
  });

  it("rejects garbage, other versions, and unimplemented sorts", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(btoa("v1:id:d:abc"))).toBeNull();
    expect(decodeCursor(btoa("v0:id:sideways:abc"))).toBeNull();
    // Well-formed, but names a sort that doesn't exist yet.
    expect(
      Cursor.safeParse(encodeCursor({ column: "name", direction: "a", value: "x" })).success,
    ).toBe(false);
    expect(Cursor.safeParse(idCursor("abc")).success).toBe(true);
  });
});

describe("PageRef", () => {
  // Both fields are optional on the wire; `loadPageById` fills in the defaults
  // (no cursor = the first page, no limit = PAGE_LIMIT_DEFAULT).
  it("accepts a bare query, and an empty `after` as the first page", () => {
    expect(PageRef.parse({})).toEqual({});
    expect(PageRef.parse({ after: "" })).toEqual({ after: "" });
  });

  it("coerces the limit from the query string and bounds it", () => {
    expect(PageRef.parse({ limit: "10" }).limit).toBe(10);
    expect(PageRef.safeParse({ limit: "0" }).success).toBe(false);
    expect(PageRef.safeParse({ limit: "1000" }).success).toBe(false);
  });

  it("rejects a malformed cursor", () => {
    expect(PageRef.safeParse({ after: "nope" }).success).toBe(false);
  });
});

describe("loadPageById", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: `id-${5 - index}` }));

  // A stand-in for the route's query: descending ids, `after` exclusive.
  async function load({ afterId, limit }: { afterId: string | null; limit: number }) {
    const start = afterId === null ? 0 : rows.findIndex((row) => row.id === afterId) + 1;
    return rows.slice(start, start + limit);
  }

  it("returns a full page plus the cursor to the next one", async () => {
    const page = await loadPageById(PageRef.parse({ limit: "2" }), load);
    expect(page.records).toEqual([{ id: "id-5" }, { id: "id-4" }]);
    expect(decodeCursor(page.next!)?.value).toBe("id-4");
  });

  it("walks every record exactly once and ends with a null cursor", async () => {
    const seen: string[] = [];
    let after = "";
    let next: string | null = null;
    do {
      const page: Page<{ id: string }> = await loadPageById(
        PageRef.parse({ limit: "2", after }),
        load,
      );
      seen.push(...page.records.map((row) => row.id));
      next = page.next;
      after = next ?? "";
    } while (next !== null);
    expect(seen).toEqual(["id-5", "id-4", "id-3", "id-2", "id-1"]);
  });

  it("has no next cursor when the last page lands exactly on the limit", async () => {
    const page = await loadPageById(PageRef.parse({ limit: "5" }), load);
    expect(page.records).toHaveLength(5);
    expect(page.next).toBeNull();
  });
});
