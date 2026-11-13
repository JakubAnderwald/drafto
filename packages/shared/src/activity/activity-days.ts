import { ACTIVITY_QUEUE_MAX_DAYS, DRAFTO_CLIENT_TAGS } from "../constants";
import type { DraftoClientTag } from "../constants";

/**
 * Activity days (ADR 0077): the UTC dates, as `YYYY-MM-DD`, on which a user
 * opened Drafto. Nothing else is recorded: no note, screen or action.
 */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC date of <date> (default: now) as `YYYY-MM-DD`. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** True for a real calendar date written as `YYYY-MM-DD`. */
export function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  // JS dates have a year 0 but Postgres's `date` doesn't, and one such day in
  // a stored queue would make record_activity reject every call that sends it.
  if (value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value;
}

/**
 * A stored queue read back as a clean one: valid days only, without
 * duplicates, oldest first, at most the newest <max>. Anything that isn't an
 * array of days (a missing or corrupt value) reads as an empty queue.
 */
export function normalizeActivityQueue(
  value: unknown,
  max: number = ACTIVITY_QUEUE_MAX_DAYS,
): string[] {
  if (!Array.isArray(value)) return [];
  const days = [...new Set(value.filter(isUtcDay))].sort();
  return max > 0 ? days.slice(-max) : [];
}

/** <queue> with <day> added: deduplicated, oldest first, the newest <max> kept. */
export function addDay(
  queue: readonly string[],
  day: string,
  max: number = ACTIVITY_QUEUE_MAX_DAYS,
): string[] {
  return normalizeActivityQueue([...queue, day], max);
}

/** <queue> without the days in <sent>, which the server has recorded. */
export function withoutSent(queue: readonly string[], sent: readonly string[]): string[] {
  const done = new Set(sent);
  return queue.filter((day) => !done.has(day));
}

/** True for one of the `x-drafto-client` tags usage_daily accepts. */
export function isDraftoClientTag(value: unknown): value is DraftoClientTag {
  return typeof value === "string" && (DRAFTO_CLIENT_TAGS as readonly string[]).includes(value);
}
