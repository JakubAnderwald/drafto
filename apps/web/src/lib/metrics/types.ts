import type {
  ActivationRow,
  ActiveUsersRow,
  DepthRow,
  EmptiedNoteRow,
  PlatformLimitRow,
  RetentionRow,
  SignupsRow,
  WritersRow,
} from "@/lib/metrics/rpc-schemas";

/**
 * One metric as the loader read it:
 * - `ok`: the function ran and its rows parsed.
 * - `unavailable`: the function doesn't exist on this database (PostgREST `PGRST202`),
 *   e.g. a project the migration hasn't reached yet.
 * - `error`: anything else. The cause went to Sentry; `message` is for the admin.
 *
 * Each metric is read on its own, so one failing leaves the others readable.
 */
export type MetricResult<T> =
  { status: "ok"; data: T } | { status: "unavailable" } | { status: "error"; message: string };

/** One share from `metrics_depth`, with the count it stands for. */
export interface DepthShare {
  /** The SQL's percentage, rounded to 0.1 points, or null when there are no writers. */
  pct: number | null;
  /** `round(pct × writers / 100)`: exact while there are fewer than 1,000 writers. */
  count: number | null;
  /** True from 1,000 writers on, where the 0.1-point rounding can move the count. */
  approximate: boolean;
  /** The writers the share is of. */
  of: number;
}

/** `metrics_depth`'s row, with each share's count derived next to its percentage. */
export interface DepthMetrics extends Omit<
  DepthRow,
  "pct_with_attachment" | "pct_with_api_key" | "pct_with_mcp_write" | "pct_multi_client"
> {
  withAttachment: DepthShare;
  withApiKey: DepthShare;
  withMcpWrite: DepthShare;
  multiClient: DepthShare;
}

/**
 * A hosting usage figure the database can't measure (egress, Vercel usage). The
 * providers' APIs don't offer it with a read-only credential on the plans in use,
 * so the page links to their usage page (see docs/features/product-metrics.md).
 */
export interface HostedUsageLink {
  provider: "Supabase" | "Vercel";
  /** What the usage page shows, e.g. "Egress". */
  resources: string;
  href: string;
}

/** Everything `/admin/stats` (and the Monday email) shows, read at `generatedAt`. */
export interface ProductMetrics {
  /** ISO timestamp the metrics were read at. */
  generatedAt: string;
  /** How many ISO weeks the weekly metrics cover, this one included. */
  weeks: number;
  /** ISO timestamp: emptied notes are listed from here on. */
  emptiedSince: string;
  /** Newest week first. */
  signups: MetricResult<SignupsRow[]>;
  /** Newest cohort first. */
  activation: MetricResult<ActivationRow[]>;
  /** Newest week first. */
  writers: MetricResult<WritersRow[]>;
  /** Null when the function returned no row. */
  depth: MetricResult<DepthMetrics | null>;
  /** Newest first. */
  emptiedNotes: MetricResult<EmptiedNoteRow[]>;
  platformLimits: MetricResult<PlatformLimitRow[]>;
  /** Newest week first. */
  activeUsers: MetricResult<ActiveUsersRow[]>;
  /** Newest cohort first. */
  retention: MetricResult<RetentionRow[]>;
  hostedUsage: HostedUsageLink[];
}
