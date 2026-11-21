import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

const { loadProductMetrics, toDepthMetrics, METRICS_WEEKS, EMPTIED_NOTES_DAYS } =
  await import("@/lib/metrics/load-product-metrics");

type Outcome = {
  data: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
};

const NOW = new Date("2026-11-21T08:00:00.000Z");
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const ROWS: Record<string, unknown[]> = {
  metrics_signups: [
    { week_start: "2026-11-09", iso_week: "2026-W46", signups: 2, by_provider: { email: 2 } },
    { week_start: "2026-11-16", iso_week: "2026-W47", signups: 1, by_provider: { google: 1 } },
  ],
  metrics_activation: [
    {
      week_start: "2026-11-09",
      iso_week: "2026-W46",
      signed_up: 2,
      first_value: 1,
      activated: 1,
      window_complete: false,
    },
    {
      week_start: "2026-09-07",
      iso_week: "2026-W37",
      signed_up: 3,
      first_value: 2,
      activated: null,
      window_complete: true,
    },
  ],
  metrics_writers: [
    {
      week_start: "2026-11-16",
      iso_week: "2026-W47",
      writers: 3,
      by_client: { web: 2, untagged: 1 },
      history_complete: true,
    },
  ],
  metrics_emptied_notes: [
    {
      note_id: NOTE_ID,
      user_id: USER_ID,
      emptied_at: "2026-11-15T10:00:00+00:00",
      client: "web",
      chars_before: 512,
    },
    {
      note_id: NOTE_ID,
      user_id: USER_ID,
      emptied_at: "2026-11-18T10:00:00+00:00",
      client: "untagged",
      chars_before: 300,
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
      pct_multi_client: null,
    },
  ],
  metrics_platform_limits: [
    {
      resource: "database",
      used_bytes: 100 * 1024 * 1024,
      limit_bytes: 500 * 1024 * 1024,
      pct: 20,
      level: "ok",
    },
    {
      resource: "storage",
      used_bytes: 900 * 1024 * 1024,
      limit_bytes: 1024 * 1024 * 1024,
      pct: 87.9,
      level: "critical",
    },
  ],
  metrics_active_users: [
    {
      week_start: "2026-11-09",
      iso_week: "2026-W46",
      active_users: 4,
      writers: 2,
      by_client: { web: 4 },
      week_complete: true,
    },
    {
      week_start: "2026-11-16",
      iso_week: "2026-W47",
      active_users: 5,
      writers: 3,
      by_client: { web: 3, "mobile-ios": 2 },
      week_complete: false,
    },
  ],
  metrics_retention: [
    {
      week_start: "2026-10-12",
      iso_week: "2026-W42",
      activated: 2,
      active_week1: 1,
      pct_week1: 50,
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

function fakeClient(overrides: Record<string, Outcome | Error> = {}) {
  const rpc = vi.fn(async (fn: string) => {
    const override = overrides[fn];
    if (override instanceof Error) throw override;
    if (override) return { count: null, ...override };
    const data = ROWS[fn];
    return { data, error: null, count: data.length };
  });
  return { rpc };
}

async function load(overrides: Record<string, Outcome | Error> = {}) {
  const client = fakeClient(overrides);
  const metrics = await loadProductMetrics({ now: NOW, client: client as never });
  return { client, metrics };
}

beforeEach(() => {
  captureException.mockReset();
  captureMessage.mockReset();
  createAdminClientMock.mockReset();
});

describe("loadProductMetrics", () => {
  it("calls every metric function read-only with the 12-week and 14-day windows", async () => {
    const { client } = await load();
    const since = new Date(NOW.getTime() - EMPTIED_NOTES_DAYS * 86_400_000).toISOString();
    expect(since).toBe("2026-11-07T08:00:00.000Z");
    const calls = Object.fromEntries(client.rpc.mock.calls.map((c) => [c[0], c.slice(1)]));
    expect(Object.keys(calls).sort()).toEqual(Object.keys(ROWS).sort());
    for (const fn of [
      "metrics_signups",
      "metrics_activation",
      "metrics_writers",
      "metrics_active_users",
      "metrics_retention",
    ]) {
      expect(calls[fn][0]).toEqual({ p_weeks: METRICS_WEEKS });
    }
    expect(METRICS_WEEKS).toBe(12);
    expect(calls.metrics_emptied_notes[0]).toEqual({ p_since: since });
    expect(calls.metrics_depth[0]).toEqual({});
    for (const [, args] of Object.entries(calls)) {
      expect(args[1]).toEqual({ get: true, count: "exact" });
    }
  });

  it("returns typed rows, newest week first, with generatedAt", async () => {
    const { metrics } = await load();
    expect(metrics.generatedAt).toBe(NOW.toISOString());
    expect(metrics.weeks).toBe(12);
    expect(metrics.signups.status).toBe("ok");
    if (metrics.signups.status !== "ok") throw new Error("unreachable");
    expect(metrics.signups.data.map((r) => r.iso_week)).toEqual(["2026-W47", "2026-W46"]);
    if (metrics.activeUsers.status !== "ok") throw new Error("expected active users");
    expect(metrics.activeUsers.data[0]).toMatchObject({ iso_week: "2026-W47", active_users: 5 });
    if (metrics.activation.status !== "ok") throw new Error("expected activation");
    expect(metrics.activation.data[1].activated).toBeNull();
    if (metrics.retention.status !== "ok") throw new Error("expected retention");
    expect(metrics.retention.data[0].active_week4).toBeNull();
    if (metrics.emptiedNotes.status !== "ok") throw new Error("expected emptied notes");
    expect(metrics.emptiedNotes.data.map((r) => r.chars_before)).toEqual([300, 512]);
    expect(metrics.platformLimits).toMatchObject({ status: "ok" });
    expect(metrics.hostedUsage.map((l) => l.provider)).toEqual(["Supabase", "Vercel"]);
    if (metrics.hostedReadings.status !== "ok") throw new Error("expected hosted readings");
    expect(metrics.hostedReadings.data.map((r) => [r.resource, r.unit, r.level])).toEqual([
      ["vercel_active_cpu", "hours", "ok"],
      ["supabase_egress", "GB", "critical"],
    ]);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("derives depth counts from the rounded shares", async () => {
    const { metrics } = await load();
    if (metrics.depth.status !== "ok" || !metrics.depth.data) throw new Error("expected depth");
    expect(metrics.depth.data.withAttachment).toEqual({
      pct: 37.5,
      count: 3,
      of: 8,
      approximate: false,
    });
    expect(metrics.depth.data.withApiKey).toEqual({
      pct: 12.5,
      count: 1,
      of: 8,
      approximate: false,
    });
    expect(metrics.depth.data.withMcpWrite).toEqual({
      pct: 0,
      count: 0,
      of: 8,
      approximate: false,
    });
    expect(metrics.depth.data.multiClient).toEqual({
      pct: null,
      count: null,
      of: 8,
      approximate: false,
    });
    expect(metrics.depth.data).not.toHaveProperty("pct_with_attachment");
  });

  it("gives null depth when the function returns no row", async () => {
    const { metrics } = await load({ metrics_depth: { data: [], error: null, count: 0 } });
    expect(metrics.depth).toEqual({ status: "ok", data: null });
  });

  it("marks a missing function (PGRST202) unavailable, reported as a warning only", async () => {
    const missing = {
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    };
    const { metrics } = await load({ metrics_active_users: missing, metrics_retention: missing });
    expect(metrics.activeUsers).toEqual({ status: "unavailable" });
    expect(metrics.retention).toEqual({ status: "unavailable" });
    expect(metrics.signups.status).toBe("ok");
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledTimes(2);
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ level: "warning" });
  });

  it("keeps a failing metric to its own section and reports it", async () => {
    const { metrics } = await load({
      metrics_signups: {
        data: null,
        error: { code: "42501", message: "permission denied for table users" },
      },
    });
    expect(metrics.signups).toEqual({
      status: "error",
      message: "metrics_signups failed (42501): permission denied for table users",
    });
    expect(metrics.activation.status).toBe("ok");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1]).toMatchObject({
      extra: { where: "product-metrics", fn: "metrics_signups" },
    });
  });

  it("reports an error without a code", async () => {
    const { metrics } = await load({
      metrics_depth: { data: null, error: { message: "timeout" } },
    });
    expect(metrics.depth).toEqual({ status: "error", message: "metrics_depth failed: timeout" });
  });

  it("turns a thrown call into that metric's error", async () => {
    const { metrics } = await load({ metrics_writers: new Error("fetch failed") });
    expect(metrics.writers).toEqual({
      status: "error",
      message: "metrics_writers failed: fetch failed",
    });
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.anything());
  });

  it("rejects rows of an unexpected shape", async () => {
    const { metrics } = await load({
      metrics_platform_limits: {
        data: [{ resource: "database", used_bytes: 1, limit_bytes: 2, pct: 50, level: "unknown" }],
        error: null,
      },
    });
    expect(metrics.platformLimits).toEqual({
      status: "error",
      message: "metrics_platform_limits returned rows of an unexpected shape",
    });
  });

  it("refuses a list that max_rows cut short", async () => {
    const { metrics } = await load({
      metrics_emptied_notes: { data: ROWS.metrics_emptied_notes, error: null, count: 1500 },
    });
    expect(metrics.emptiedNotes).toEqual({
      status: "error",
      message: "metrics_emptied_notes returned only 2 of 1500 rows (the API's max_rows limit)",
    });
  });

  it("drops keys the schemas don't list, so no stray personal field reaches the page", async () => {
    const { metrics } = await load({
      metrics_emptied_notes: {
        data: [{ ...(ROWS.metrics_emptied_notes[0] as object), email: "someone@example.com" }],
        error: null,
      },
    });
    if (metrics.emptiedNotes.status !== "ok") throw new Error("expected emptied notes");
    expect(metrics.emptiedNotes.data[0]).not.toHaveProperty("email");
  });

  it("uses the service-role client by default", async () => {
    const client = fakeClient();
    createAdminClientMock.mockReturnValue(client);
    await loadProductMetrics({ now: NOW });
    expect(createAdminClientMock).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledTimes(9);
  });

  it("defaults now to the current time", async () => {
    const client = fakeClient();
    const before = Date.now();
    const metrics = await loadProductMetrics({ client: client as never });
    expect(Date.parse(metrics.generatedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe("toDepthMetrics", () => {
  it("flags counts derived for 1,000 or more writers as approximate", () => {
    const depth = toDepthMetrics({
      writers: 1500,
      live_notes_median: 3,
      live_notes_max: 90,
      notebooks_median: 1,
      notebooks_max: 9,
      attachment_mb_median: 0,
      attachment_mb_max: 4,
      pct_with_attachment: 40,
      pct_with_api_key: null,
      pct_with_mcp_write: 1.1,
      pct_multi_client: 10,
    });
    expect(depth.withAttachment).toEqual({ pct: 40, count: 600, of: 1500, approximate: true });
    expect(depth.withApiKey.approximate).toBe(true);
  });

  it("handles no writers", () => {
    const depth = toDepthMetrics({
      writers: 0,
      live_notes_median: null,
      live_notes_max: null,
      notebooks_median: null,
      notebooks_max: null,
      attachment_mb_median: null,
      attachment_mb_max: null,
      pct_with_attachment: null,
      pct_with_api_key: null,
      pct_with_mcp_write: null,
      pct_multi_client: null,
    });
    expect(depth.withAttachment).toEqual({ pct: null, count: null, of: 0, approximate: false });
  });
});
