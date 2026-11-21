import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { hostedUsageLinks } from "@/lib/metrics/hosted-usage";
import {
  activationRowSchema,
  activeUsersRowSchema,
  depthRowSchema,
  emptiedNoteRowSchema,
  platformLimitRowSchema,
  retentionRowSchema,
  signupsRowSchema,
  writersRowSchema,
  type DepthRow,
} from "@/lib/metrics/rpc-schemas";
import type { DepthMetrics, DepthShare, MetricResult, ProductMetrics } from "@/lib/metrics/types";

/** ISO weeks the weekly metrics cover, this one included. */
export const METRICS_WEEKS = 12;
/** Emptied notes are listed from this many days back. */
export const EMPTIED_NOTES_DAYS = 14;

const DAY_MS = 86_400_000;
/** PostgREST: the function isn't in the schema cache, i.e. it doesn't exist there. */
const FUNCTION_NOT_FOUND = "PGRST202";

type MetricFunction =
  | "metrics_signups"
  | "metrics_activation"
  | "metrics_writers"
  | "metrics_emptied_notes"
  | "metrics_depth"
  | "metrics_platform_limits"
  | "metrics_active_users"
  | "metrics_retention";

interface RpcError {
  code?: string;
  message: string;
}

interface RpcOutcome {
  data: unknown;
  error: RpcError | null;
  count: number | null;
}

export type MetricsClient = Pick<SupabaseClient<Database>, "rpc">;

/**
 * The one untyped call. The hand-written `Database` type has
 * `Functions: Record<string, never>`, so the function name and arguments are cast
 * here (as in `api/notes/search/route.ts`), and every caller parses the `unknown`
 * result with zod.
 *
 * `get: true` sends `GET /rest/v1/rpc/<fn>`, which PostgREST runs in a read-only
 * transaction. `count: "exact"` lets the caller notice PostgREST's silent
 * `max_rows` cap.
 */
async function callRpc(
  client: MetricsClient,
  fn: MetricFunction,
  args: Record<string, string | number>,
): Promise<RpcOutcome> {
  const { data, error, count } = (await client.rpc(fn as never, args as never, {
    get: true,
    count: "exact",
  })) as unknown as RpcOutcome;
  return { data, error, count };
}

function failure<T>(fn: MetricFunction, message: string, cause?: unknown): MetricResult<T> {
  Sentry.captureException(cause instanceof Error ? cause : new Error(`${fn}: ${message}`), {
    extra: { where: "product-metrics", fn, message },
  });
  return { status: "error", message };
}

/** Reads one metric and parses its rows. Never throws: a failure is that metric's `error`. */
async function readMetric<Row, T>(
  client: MetricsClient,
  fn: MetricFunction,
  args: Record<string, string | number>,
  rowSchema: z.ZodType<Row>,
  shape: (rows: Row[]) => T,
): Promise<MetricResult<T>> {
  let outcome: RpcOutcome;
  try {
    outcome = await callRpc(client, fn, args);
  } catch (err) {
    return failure(fn, `${fn} failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  const { data, error, count } = outcome;
  if (error) {
    if (error.code === FUNCTION_NOT_FOUND) return { status: "unavailable" };
    const code = error.code ? ` (${error.code})` : "";
    return failure(fn, `${fn} failed${code}: ${error.message}`);
  }
  const parsed = z.array(rowSchema).safeParse(data);
  if (!parsed.success) {
    return failure(fn, `${fn} returned rows of an unexpected shape`, parsed.error);
  }
  if (count !== null && parsed.data.length < count) {
    return failure(
      fn,
      `${fn} returned only ${parsed.data.length} of ${count} rows (the API's max_rows limit)`,
    );
  }
  return { status: "ok", data: shape(parsed.data) };
}

function newestFirst<Row extends { week_start: string }>(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => b.week_start.localeCompare(a.week_start));
}

function share(pct: number | null, writers: number): DepthShare {
  return { pct, count: pct === null ? null : Math.round((pct * writers) / 100), of: writers };
}

/** `metrics_depth`'s row with each share's count beside its percentage. */
export function toDepthMetrics(row: DepthRow): DepthMetrics {
  const { pct_with_attachment, pct_with_api_key, pct_with_mcp_write, pct_multi_client, ...rest } =
    row;
  return {
    ...rest,
    withAttachment: share(pct_with_attachment, row.writers),
    withApiKey: share(pct_with_api_key, row.writers),
    withMcpWrite: share(pct_with_mcp_write, row.writers),
    multiClient: share(pct_multi_client, row.writers),
  };
}

export interface LoadProductMetricsOptions {
  now?: Date;
  /** Defaults to the service-role client. Callers must have authorized an admin first. */
  client?: MetricsClient;
}

/**
 * Reads every product metric (ADR 0075, ADR 0088) through the service role, each
 * on its own and in parallel. Server-only: the caller must have checked the user
 * is an admin (or, for the cron, the cron secret) before calling it.
 */
export async function loadProductMetrics({
  now = new Date(),
  client = createAdminClient(),
}: LoadProductMetricsOptions = {}): Promise<ProductMetrics> {
  const weeks = { p_weeks: METRICS_WEEKS };
  const emptiedSince = new Date(now.getTime() - EMPTIED_NOTES_DAYS * DAY_MS).toISOString();

  const [
    signups,
    activation,
    writers,
    emptiedNotes,
    depth,
    platformLimits,
    activeUsers,
    retention,
  ] = await Promise.all([
    readMetric(client, "metrics_signups", weeks, signupsRowSchema, newestFirst),
    readMetric(client, "metrics_activation", weeks, activationRowSchema, newestFirst),
    readMetric(client, "metrics_writers", weeks, writersRowSchema, newestFirst),
    readMetric(
      client,
      "metrics_emptied_notes",
      { p_since: emptiedSince },
      emptiedNoteRowSchema,
      (rows) => [...rows].sort((a, b) => b.emptied_at.localeCompare(a.emptied_at)),
    ),
    readMetric(client, "metrics_depth", {}, depthRowSchema, (rows) =>
      rows[0] ? toDepthMetrics(rows[0]) : null,
    ),
    readMetric(client, "metrics_platform_limits", {}, platformLimitRowSchema, (rows) => rows),
    readMetric(client, "metrics_active_users", weeks, activeUsersRowSchema, newestFirst),
    readMetric(client, "metrics_retention", weeks, retentionRowSchema, newestFirst),
  ]);

  return {
    generatedAt: now.toISOString(),
    weeks: METRICS_WEEKS,
    emptiedSince,
    signups,
    activation,
    writers,
    depth,
    emptiedNotes,
    platformLimits,
    activeUsers,
    retention,
    hostedUsage: hostedUsageLinks(),
  };
}
