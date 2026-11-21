import { z } from "zod";

/**
 * Row schemas for the service-role metric functions (ADR 0075, ADR 0088), one per
 * function, matching its `returns table (…)` in `supabase/migrations/`. PostgREST
 * returns `date` as "YYYY-MM-DD", `timestamptz` as an ISO string, and `int`,
 * `bigint` and `numeric` as JSON numbers. A missing column or a value of the wrong
 * type fails the parse, and the loader shows that metric as an error instead of a
 * wrong number. A column a schema doesn't list is dropped, not an error.
 *
 * None of these rows carries an email, note text, title or notebook name, and the
 * schemas keep it that way: zod drops any key they don't list.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().nonnegative();
const perKeyCounts = z.record(z.string(), count);

/** `metrics_signups(p_weeks)` (20261112000002_product_metrics.sql). */
export const signupsRowSchema = z.object({
  week_start: isoDate,
  iso_week: z.string(),
  signups: count,
  by_provider: perKeyCounts,
});

/** `metrics_activation(p_weeks)`. `activated` is null once the history is purged. */
export const activationRowSchema = z.object({
  week_start: isoDate,
  iso_week: z.string(),
  signed_up: count,
  first_value: count,
  activated: count.nullable(),
  window_complete: z.boolean(),
});

/** `metrics_writers(p_weeks)`. */
export const writersRowSchema = z.object({
  week_start: isoDate,
  iso_week: z.string(),
  writers: count,
  by_client: perKeyCounts,
  history_complete: z.boolean(),
});

/** `metrics_emptied_notes(p_since)`. Identified by ids only. */
export const emptiedNoteRowSchema = z.object({
  note_id: z.guid(),
  user_id: z.guid(),
  emptied_at: z.string(),
  client: z.string(),
  chars_before: count,
});

/** `metrics_depth()`: one row. With no writers, the medians, maxima and shares are null. */
export const depthRowSchema = z.object({
  writers: count,
  live_notes_median: z.number().nullable(),
  live_notes_max: count.nullable(),
  notebooks_median: z.number().nullable(),
  notebooks_max: count.nullable(),
  attachment_mb_median: z.number().nullable(),
  attachment_mb_max: z.number().nullable(),
  pct_with_attachment: z.number().nullable(),
  pct_with_api_key: z.number().nullable(),
  pct_with_mcp_write: z.number().nullable(),
  pct_multi_client: z.number().nullable(),
});

/** `metrics_platform_limits()`. The thresholds behind `level` live in the SQL. */
export const platformLimitRowSchema = z.object({
  resource: z.string(),
  used_bytes: z.number().nonnegative(),
  limit_bytes: z.number().positive(),
  pct: z.number(),
  level: z.enum(["ok", "warn", "critical"]),
});

/** `metrics_active_users(p_weeks)` (20261113000003_usage_daily.sql). */
export const activeUsersRowSchema = z.object({
  week_start: isoDate,
  iso_week: z.string(),
  active_users: count,
  writers: count,
  by_client: perKeyCounts,
  week_complete: z.boolean(),
});

/** `metrics_retention(p_weeks)`. Every count and share can be null (see the doc's null cases). */
export const retentionRowSchema = z.object({
  week_start: isoDate,
  iso_week: z.string(),
  activated: count.nullable(),
  active_week1: count.nullable(),
  pct_week1: z.number().nullable(),
  active_week4: count.nullable(),
  pct_week4: z.number().nullable(),
});

/**
 * `metrics_hosted_usage()` (20261121000002_hosted_usage_snapshots.sql, ADR 0091): the newest
 * dashboard reading per Vercel / Supabase resource against its plan limit.
 */
export const hostedUsageRowSchema = z.object({
  provider: z.enum(["vercel", "supabase"]),
  resource: z.string(),
  unit: z.enum(["GB", "count", "hours"]),
  used: z.number().nonnegative(),
  limit_value: z.number().positive(),
  pct: z.number(),
  level: z.enum(["ok", "warn", "critical"]),
  period_from: isoDate.nullable(),
  period_to: isoDate.nullable(),
  captured_at: z.string(),
  stale: z.boolean(),
});

export type SignupsRow = z.infer<typeof signupsRowSchema>;
export type ActivationRow = z.infer<typeof activationRowSchema>;
export type WritersRow = z.infer<typeof writersRowSchema>;
export type EmptiedNoteRow = z.infer<typeof emptiedNoteRowSchema>;
export type DepthRow = z.infer<typeof depthRowSchema>;
export type PlatformLimitRow = z.infer<typeof platformLimitRowSchema>;
export type PlatformLimitLevel = PlatformLimitRow["level"];
export type ActiveUsersRow = z.infer<typeof activeUsersRowSchema>;
export type RetentionRow = z.infer<typeof retentionRowSchema>;
export type HostedUsageRow = z.infer<typeof hostedUsageRowSchema>;
