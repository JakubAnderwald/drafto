/**
 * What a sync pull stores for a note's content: `JSON.stringify` of the
 * server's jsonb (apps/desktop/src/db/sync.ts), whose object keys come back
 * sorted by length, then bytewise — the same data in different bytes.
 */
export function jsonbReordered(content: string): string {
  const reorder = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reorder);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, reorder(item)]),
    );
  };
  return JSON.stringify(reorder(JSON.parse(content)));
}
