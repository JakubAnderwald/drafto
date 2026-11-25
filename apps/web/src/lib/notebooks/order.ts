/** The ordering fields every notebook row carries. */
export interface NotebookOrderFields {
  updated_at: string;
}

/**
 * Newest `updated_at` first: the order `GET /api/notebooks` and the layout prefetch return,
 * and the order mobile and desktop show. Use it with `Array.prototype.sort`, which is stable,
 * so notebooks with the same timestamp keep the server's order.
 *
 * Timestamps are compared as instants, not strings: PostgREST returns `+00:00` offsets with
 * microseconds, while a client-made row may carry a `Z` ISO string.
 */
export function compareNewestFirst(a: NotebookOrderFields, b: NotebookOrderFields): number {
  const diff = toMillis(b.updated_at) - toMillis(a.updated_at);
  // Two unparseable timestamps (-Infinity - -Infinity) tie instead of yielding NaN.
  return Number.isNaN(diff) ? 0 : diff;
}

function toMillis(timestamp: string): number {
  const ms = Date.parse(timestamp);
  // An unparseable timestamp sorts last rather than poisoning the comparison with NaN.
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}
