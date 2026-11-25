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
 * microseconds, while a client-made row may carry a `Z` ISO string. The comparison keeps the
 * microseconds, as Postgres's `updated_at desc` does.
 */
export function compareNewestFirst(a: NotebookOrderFields, b: NotebookOrderFields): number {
  const diff = toMicros(b.updated_at) - toMicros(a.updated_at);
  // Two unparseable timestamps (-Infinity - -Infinity) tie instead of yielding NaN.
  return Number.isNaN(diff) ? 0 : diff;
}

/** The seconds-fraction of an ISO timestamp, e.g. `.123456` in `10:00:00.123456+00:00`. */
const SECONDS_FRACTION = /(\d{2}:\d{2}:\d{2})\.(\d+)/;

function toMicros(timestamp: string): number {
  // `Date.parse` keeps only milliseconds, so it would tie two timestamps in the same
  // millisecond. Parse the whole seconds and add the fraction's microseconds separately.
  const match = SECONDS_FRACTION.exec(timestamp);
  const ms = Date.parse(match ? timestamp.replace(SECONDS_FRACTION, "$1") : timestamp);
  // An unparseable timestamp sorts last rather than poisoning the comparison with NaN.
  if (Number.isNaN(ms)) return Number.NEGATIVE_INFINITY;
  const micros = Number((match?.[2] ?? "").slice(0, 6).padEnd(6, "0"));
  // Epoch microseconds stay below Number.MAX_SAFE_INTEGER until the year 2255.
  return ms * 1000 + micros;
}
