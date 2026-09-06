/**
 * Postgres `timestamptz` reaches the browser in two different spellings for the
 * same instant, and they must never be compared as strings:
 *
 * - PostgREST (our REST API) serialises ISO-8601: `2026-09-06T12:34:56.789012+00:00`
 * - Supabase Realtime forwards the raw Postgres text form: `2026-09-06 12:34:56.789012+00`
 *   (`realtime-js` deliberately routes `timestamptz` through a no-op transformer so
 *   consumers can apply their own timezone handling)
 *
 * Normalise to epoch milliseconds instead. The rewriting below is explicit rather
 * than leaning on `Date.parse` leniency — V8 happens to accept the space separator
 * and a bare `+00` offset, but that is not specified behaviour across engines.
 */
export function toEpochMs(ts: string | null | undefined): number {
  if (!ts) return Number.NEGATIVE_INFINITY;

  const iso = ts
    .replace(" ", "T") // date/time separator
    .replace(/(\.\d{3})\d+/, "$1") // micro/nanoseconds -> milliseconds
    .replace(/([+-]\d{2})$/, "$1:00") // "+00"   -> "+00:00"
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2"); // "+0000" -> "+00:00"

  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * The later of two timestamps, tolerating either (or both) being absent.
 * Returns the original string so the caller keeps the server's own formatting.
 */
export function maxTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return toEpochMs(a) >= toEpochMs(b) ? a : b;
}
