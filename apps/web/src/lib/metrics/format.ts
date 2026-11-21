import { DRAFTO_CLIENT_TAGS } from "@drafto/shared";

/**
 * Formatting for the product metrics. Rates always come with their counts, because
 * at Drafto's size one user moves a rate by more than 10 points.
 */

/** Activity-day client columns, in ADR 0023's order (as `ACTIVE_CLIENT_COLUMNS` in scripts/user-stats.mjs). */
export const ACTIVE_CLIENT_COLUMNS: readonly string[] = DRAFTO_CLIENT_TAGS;
/** The writers table adds writes that carried no tag (as `CLIENT_COLUMNS` in scripts/user-stats.mjs). */
export const CLIENT_COLUMNS: readonly string[] = [...DRAFTO_CLIENT_TAGS, "untagged"];
/** Sign-up providers shown first; any other provider follows. */
export const PROVIDER_COLUMNS: readonly string[] = ["email", "google", "apple"];

/** Shown where a value is null: not measured, never zero. */
export const NOT_AVAILABLE = "—";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function decimal(value: number, maxFractionDigits: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });
}

/** "12.5%", or "—" for null. */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${decimal(value, 1)}%`;
}

/** "1 of 8 (12.5%)"; "0 of 0" has no percentage; a null count is "—". */
export function formatCountOf(count: number | null | undefined, of: number): string {
  if (count === null || count === undefined) return NOT_AVAILABLE;
  if (of === 0) return `${count} of 0`;
  return `${count} of ${of} (${formatPct((100 * count) / of)})`;
}

/** Binary units, as the SQL uses: "500 MB", "1 GB", "1.25 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${decimal(bytes / GB, 2)} GB`;
  return `${decimal(bytes / MB, 1)} MB`;
}

/** A median or other fractional value, or "—". */
export function formatNumber(value: number | null | undefined, maxFractionDigits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return decimal(value, maxFractionDigits);
}

/** "2026-11-21 08:05 UTC". */
export function formatUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The columns for a set of per-key count objects (`by_client`, `by_provider`):
 * every key of `order` (all of them when `always`, else only those seen), then any
 * other key seen, alphabetically.
 */
export function columnsFor(
  objects: readonly (Record<string, number> | null | undefined)[],
  order: readonly string[],
  { always = false }: { always?: boolean } = {},
): string[] {
  const seen = new Set(objects.flatMap((o) => Object.keys(o ?? {})));
  const rest = [...seen].filter((k) => !order.includes(k)).sort((a, b) => a.localeCompare(b));
  return [...order.filter((k) => always || seen.has(k)), ...rest];
}

/** A hosting-usage amount in its dashboard unit: "1.42 GB", "195,000", "2h 17m". */
export function formatHostedAmount(value: number, unit: "GB" | "count" | "hours"): string {
  if (!Number.isFinite(value)) return NOT_AVAILABLE;
  if (unit === "GB") return `${decimal(value, 2)} GB`;
  if (unit === "count") return decimal(value, 0);
  const minutes = Math.round(value * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** How many UTC calendar days before `now` something happened: "today", "1 day ago", "9 days ago". */
export function formatAge(iso: string, now: string): string {
  const day = (t: string) => Math.floor(Date.parse(t) / 86_400_000);
  const days = day(now) - day(iso);
  if (!Number.isFinite(days)) return NOT_AVAILABLE;
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
