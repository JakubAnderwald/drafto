import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NeedsAttentionSection } from "@/app/(app)/admin/stats/needs-attention-section";
import { PlatformLimitsSection } from "@/app/(app)/admin/stats/platform-limits-section";
import { ActivationSection } from "@/app/(app)/admin/stats/activation-section";
import { WritersSection } from "@/app/(app)/admin/stats/writers-section";
import { DepthSection } from "@/app/(app)/admin/stats/depth-section";
import { SignupsSection } from "@/app/(app)/admin/stats/signups-section";
import {
  ActiveUsersSection,
  USAGE_TRACKING_PENDING,
} from "@/app/(app)/admin/stats/active-users-section";
import { LIMIT_LEVEL_TONE, resourceLabel } from "@/app/(app)/admin/stats/limit-level";
import { DEFAULT_UNAVAILABLE_TEXT } from "@/app/(app)/admin/stats/metric-result-view";
import { HostedUsageList, NO_READOUT_TEXT } from "@/app/(app)/admin/stats/hosted-usage-list";
import type { HostedUsageRow } from "@/lib/metrics/rpc-schemas";
import type { NeedsAttention } from "@/lib/metrics/needs-attention";

const clear: NeedsAttention = {
  emptiedNotes: [],
  limits: [],
  hostedLimits: [],
  readoutStaleSince: null,
  unchecked: [],
  isClear: true,
};
const unavailable = { status: "unavailable" } as const;
const NOW = "2026-11-21T08:00:00.000Z";
const failed = { status: "error", message: "metrics_x failed (42501): permission denied" } as const;

describe("Needs attention", () => {
  it("says nothing needs attention when every check is clear", () => {
    render(<NeedsAttentionSection needsAttention={clear} emptiedNotesDays={14} />);
    expect(screen.getByText("Nothing needs attention")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("lists limits at warn or critical and the checks that couldn't run", () => {
    render(
      <NeedsAttentionSection
        emptiedNotesDays={14}
        needsAttention={{
          emptiedNotes: [],
          limits: [
            {
              resource: "storage",
              used_bytes: 900 * 1024 ** 2,
              limit_bytes: 1024 ** 3,
              pct: 87.9,
              level: "critical",
            },
          ],
          hostedLimits: [],
          readoutStaleSince: null,
          unchecked: [{ check: "Emptied notes", reason: "metrics_emptied_notes failed: timeout" }],
          isClear: false,
        }}
      />,
    );
    expect(screen.queryByText("Nothing needs attention")).not.toBeInTheDocument();
    expect(screen.getByText(/Storage: 900 MB of 1 GB/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't check emptied notes: metrics_emptied_notes failed: timeout",
    );
    const card = screen.getByTestId("metrics-section-needs-attention").firstElementChild;
    expect(card).toHaveClass("bg-warning-bg");
    expect(card).not.toHaveClass("bg-bg-subtle");
  });
});

describe("section states", () => {
  it("shows the error state in its own section", () => {
    render(<ActivationSection activation={failed} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load this metric: metrics_x failed (42501)",
    );
  });

  it("shows the default unavailable text", () => {
    render(<SignupsSection signups={unavailable} />);
    expect(screen.getByText(DEFAULT_UNAVAILABLE_TEXT)).toBeInTheDocument();
  });

  it("says active users and retention arrive with usage tracking", () => {
    render(<ActiveUsersSection activeUsers={unavailable} retention={unavailable} />);
    expect(screen.getAllByText(USAGE_TRACKING_PENDING)).toHaveLength(2);
  });

  it.each([
    [
      "activation",
      () => <ActivationSection activation={{ status: "ok", data: [] }} />,
      "No sign-up weeks.",
    ],
    ["writers", () => <WritersSection writers={{ status: "ok", data: [] }} />, "No weeks."],
    ["signups", () => <SignupsSection signups={{ status: "ok", data: [] }} />, "No weeks."],
    ["depth", () => <DepthSection depth={{ status: "ok", data: null }} />, "No depth figures."],
    [
      "platform limits",
      () => (
        <PlatformLimitsSection
          platformLimits={{ status: "ok", data: [] }}
          hostedReadings={{ status: "ok", data: [] }}
          hostedUsage={[]}
          now={NOW}
        />
      ),
      "No limits reported.",
    ],
  ])("shows the %s empty state", (_name, ui, text) => {
    render(ui());
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("shows empty active users and retention tables as empty", () => {
    render(
      <ActiveUsersSection
        activeUsers={{ status: "ok", data: [] }}
        retention={{ status: "ok", data: [] }}
      />,
    );
    expect(screen.getByText("No weeks.")).toBeInTheDocument();
    expect(screen.getByText("No cohorts.")).toBeInTheDocument();
  });
});

describe("active users and retention footnotes", () => {
  const week = {
    week_start: "2026-11-16",
    iso_week: "2026-W47",
    active_users: 0,
    writers: 0,
    by_client: {},
    week_complete: true,
  };
  const cohort = {
    week_start: "2026-10-12",
    iso_week: "2026-W42",
    activated: 4,
    active_week1: 3,
    pct_week1: 75,
    active_week4: 2,
    pct_week4: 50,
  };

  it("explains zero weeks, and the retention dash only when a cell has one", () => {
    const { rerender } = render(
      <ActiveUsersSection
        activeUsers={{ status: "ok", data: [week] }}
        retention={{ status: "ok", data: [cohort] }}
      />,
    );
    expect(screen.getByText(/Weeks before activity days were recorded/)).toBeInTheDocument();
    expect(screen.getByText("0 of 0")).toBeInTheDocument();
    expect(screen.getByText("2 of 4 (50%)")).toBeInTheDocument();
    expect(screen.queryByText(/the window is still open/)).not.toBeInTheDocument();

    rerender(
      <ActiveUsersSection
        activeUsers={{ status: "ok", data: [week] }}
        retention={{ status: "ok", data: [{ ...cohort, active_week4: null, pct_week4: null }] }}
      />,
    );
    expect(screen.getByText(/the window is still open/)).toBeInTheDocument();
  });
});

describe("depth shares", () => {
  it("marks counts derived from 1,000+ writers as approximate", () => {
    const share = (count: number | null) => ({ pct: 10, count, of: 1500, approximate: true });
    render(
      <DepthSection
        depth={{
          status: "ok",
          data: {
            writers: 1500,
            live_notes_median: 3,
            live_notes_max: 90,
            notebooks_median: 1,
            notebooks_max: 9,
            attachment_mb_median: 0,
            attachment_mb_max: 4,
            withAttachment: share(150),
            withApiKey: { pct: null, count: null, of: 1500, approximate: true },
            withMcpWrite: share(150),
            multiClient: share(150),
          },
        }}
      />,
    );
    expect(screen.getAllByText("≈150 of 1500 (10%)")).toHaveLength(3);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("limit levels", () => {
  it("maps the SQL's levels to the bar tones", () => {
    expect(LIMIT_LEVEL_TONE).toEqual({ ok: "success", warn: "warning", critical: "danger" });
    expect(resourceLabel("database")).toBe("Database");
  });

  it("colours each bar by its level and links to hosted usage", () => {
    render(
      <PlatformLimitsSection
        hostedReadings={{ status: "unavailable" }}
        now={NOW}
        platformLimits={{
          status: "ok",
          data: [
            {
              resource: "database",
              used_bytes: 100 * 1024 ** 2,
              limit_bytes: 500 * 1024 ** 2,
              pct: 20,
              level: "ok",
            },
          ],
        }}
        hostedUsage={[
          {
            provider: "Vercel",
            resources: "Fast data transfer",
            href: "https://vercel.com/x/~/usage",
          },
        ]}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Database used" })).toHaveAttribute(
      "aria-valuenow",
      "20",
    );
    expect(screen.getByTestId("progress-bar-fill")).toHaveClass("bg-success");
    expect(screen.getByText("100 MB of 500 MB (20%)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See the Vercel usage page" })).toHaveAttribute(
      "href",
      "https://vercel.com/x/~/usage",
    );
  });
});

describe("hosting usage readout", () => {
  const row = (over: Partial<HostedUsageRow> = {}): HostedUsageRow => ({
    provider: "vercel",
    resource: "vercel_cdn_requests",
    unit: "count",
    used: 750000,
    limit_value: 1000000,
    pct: 75,
    level: "warn",
    period_from: "2026-10-22",
    period_to: "2026-11-21",
    captured_at: "2026-11-11T19:00:00+00:00",
    stale: true,
    ...over,
  });

  it("explains a readout that hasn't run, or isn't set up", () => {
    const { rerender } = render(
      <HostedUsageList readings={{ status: "ok", data: [] }} now={NOW} />,
    );
    expect(screen.getByText(NO_READOUT_TEXT)).toBeInTheDocument();
    rerender(<HostedUsageList readings={unavailable} now={NOW} />);
    expect(screen.getByText(NO_READOUT_TEXT)).toBeInTheDocument();
  });

  it("shows each reading against its limit, with its age, period and staleness", () => {
    render(<HostedUsageList readings={{ status: "ok", data: [row()] }} now={NOW} />);
    const item = screen.getByTestId("hosted-vercel_cdn_requests");
    expect(item).toHaveTextContent("Vercel — CDN requests750,000 of 1,000,000 (75%)warnstale");
    expect(item).toHaveTextContent(
      "Read 2026-11-11 19:00 UTC (10 days ago) · usage 2026-10-22 to 2026-11-21",
    );
    expect(screen.getByRole("progressbar", { name: "Vercel — CDN requests used" })).toHaveAttribute(
      "aria-valuenow",
      "75",
    );
  });

  it("shows Supabase log ingestion over its 1 GB limit as critical", () => {
    const logs = row({
      provider: "supabase",
      resource: "supabase_log_ingestion",
      unit: "GB",
      used: 1.02,
      limit_value: 1,
      pct: 102,
      level: "critical",
      period_from: "2026-10-25",
      period_to: "2026-11-25",
      stale: false,
    });
    render(<HostedUsageList readings={{ status: "ok", data: [logs] }} now={NOW} />);
    expect(screen.getByTestId("hosted-supabase_log_ingestion")).toHaveTextContent(
      "Supabase — Log ingestion1.02 GB of 1 GB (102%)critical",
    );
    expect(
      screen.getByRole("progressbar", { name: "Supabase — Log ingestion used" }),
    ).toHaveAttribute("aria-valuenow", "100");
  });

  it("lists high and stale readings under Needs attention", () => {
    render(
      <NeedsAttentionSection
        emptiedNotesDays={14}
        needsAttention={{
          ...clear,
          hostedLimits: [row()],
          readoutStaleSince: "2026-11-11T19:00:00+00:00",
          isClear: false,
        }}
      />,
    );
    expect(
      screen.getByText(/Vercel — CDN requests: 750,000 of 1,000,000 \(75%\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The weekly usage readout hasn.t run since 2026-11-11 19:00 UTC/),
    ).toBeInTheDocument();
  });
});
