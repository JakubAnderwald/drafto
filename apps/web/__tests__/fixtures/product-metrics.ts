import type { ProductMetrics } from "@/lib/metrics/types";

/** Raw rows as the metric functions return them, for faking `rpc`. */
export const METRIC_ROWS: Record<string, unknown[]> = {
  metrics_signups: [
    {
      week_start: "2026-11-16",
      iso_week: "2026-W47",
      signups: 3,
      by_provider: { email: 2, google: 1 },
    },
    { week_start: "2026-11-09", iso_week: "2026-W46", signups: 1, by_provider: { apple: 1 } },
  ],
  metrics_activation: [
    {
      week_start: "2026-11-16",
      iso_week: "2026-W47",
      signed_up: 3,
      first_value: 2,
      activated: 1,
      window_complete: false,
    },
    {
      week_start: "2026-09-07",
      iso_week: "2026-W37",
      signed_up: 8,
      first_value: 4,
      activated: null,
      window_complete: true,
    },
  ],
  metrics_writers: [
    {
      week_start: "2026-11-16",
      iso_week: "2026-W47",
      writers: 5,
      by_client: { web: 3, "mobile-ios": 2, untagged: 1 },
      history_complete: true,
    },
    {
      week_start: "2026-10-12",
      iso_week: "2026-W42",
      writers: 4,
      by_client: { web: 4 },
      history_complete: false,
    },
  ],
  metrics_emptied_notes: [
    {
      note_id: "11111111-1111-4111-8111-111111111111",
      user_id: "22222222-2222-4222-8222-222222222222",
      emptied_at: "2026-11-18T10:00:00+00:00",
      client: "web",
      chars_before: 1234,
    },
  ],
  metrics_depth: [
    {
      writers: 8,
      live_notes_median: 12.5,
      live_notes_max: 40,
      notebooks_median: 2,
      notebooks_max: 6,
      attachment_mb_median: 0.4,
      attachment_mb_max: 12.25,
      pct_with_attachment: 37.5,
      pct_with_api_key: 12.5,
      pct_with_mcp_write: 0,
      pct_multi_client: 25,
    },
  ],
  metrics_platform_limits: [
    { resource: "database", used_bytes: 104857600, limit_bytes: 524288000, pct: 20, level: "ok" },
    { resource: "storage", used_bytes: 805306368, limit_bytes: 1073741824, pct: 75, level: "warn" },
  ],
  metrics_active_users: [
    {
      week_start: "2026-11-16",
      iso_week: "2026-W47",
      active_users: 6,
      writers: 4,
      by_client: { web: 5, "desktop-macos": 1 },
      week_complete: false,
    },
  ],
  metrics_retention: [
    {
      week_start: "2026-10-12",
      iso_week: "2026-W42",
      activated: 4,
      active_week1: 3,
      pct_week1: 75,
      active_week4: null,
      pct_week4: null,
    },
  ],
  metrics_hosted_usage: [
    {
      provider: "vercel",
      resource: "vercel_active_cpu",
      unit: "hours",
      used: 2.2833,
      limit_value: 4,
      pct: 57.1,
      level: "ok",
      period_from: "2026-10-22",
      period_to: "2026-11-21",
      captured_at: "2026-11-15T19:00:00+00:00",
      stale: false,
    },
    {
      provider: "supabase",
      resource: "supabase_egress",
      unit: "GB",
      used: 4.25,
      limit_value: 5,
      pct: 85,
      level: "critical",
      period_from: null,
      period_to: null,
      captured_at: "2026-11-15T19:00:00+00:00",
      stale: false,
    },
  ],
};

/** A fake service-role client whose `rpc` answers from METRIC_ROWS (or an override). */
export function fakeMetricsClient(
  overrides: Record<
    string,
    { data: unknown; error: { code?: string; message: string } | null }
  > = {},
) {
  return {
    rpc: async (fn: string) => {
      const override = overrides[fn];
      if (override) return { count: null, ...override };
      const data = METRIC_ROWS[fn] ?? [];
      return { data, error: null, count: data.length };
    },
  };
}

/** A ProductMetrics object with every metric empty but ok. */
export function emptyMetrics(): ProductMetrics {
  return {
    generatedAt: "2026-11-21T08:00:00.000Z",
    weeks: 12,
    emptiedSince: "2026-11-07T08:00:00.000Z",
    signups: { status: "ok", data: [] },
    activation: { status: "ok", data: [] },
    writers: { status: "ok", data: [] },
    depth: { status: "ok", data: null },
    emptiedNotes: { status: "ok", data: [] },
    platformLimits: { status: "ok", data: [] },
    activeUsers: { status: "ok", data: [] },
    retention: { status: "ok", data: [] },
    hostedReadings: { status: "ok", data: [] },
    hostedUsage: [
      {
        provider: "Supabase",
        resources: "Egress",
        href: "https://supabase.com/dashboard/org/_/usage",
      },
    ],
  };
}
