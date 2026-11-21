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
import type { NeedsAttention } from "@/lib/metrics/needs-attention";

const clear: NeedsAttention = { emptiedNotes: [], limits: [], unchecked: [], isClear: true };
const unavailable = { status: "unavailable" } as const;
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
          unchecked: ["Emptied notes"],
          isClear: false,
        }}
      />,
    );
    expect(screen.queryByText("Nothing needs attention")).not.toBeInTheDocument();
    expect(screen.getByText(/Storage: 900 MB of 1 GB/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't check: Emptied notes");
    expect(
      screen.getByTestId("metrics-section-needs-attention").querySelector(".bg-warning-bg"),
    ).not.toBeNull();
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
      () => <PlatformLimitsSection platformLimits={{ status: "ok", data: [] }} hostedUsage={[]} />,
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

describe("limit levels", () => {
  it("maps the SQL's levels to the bar tones", () => {
    expect(LIMIT_LEVEL_TONE).toEqual({ ok: "success", warn: "warning", critical: "danger" });
    expect(resourceLabel("database")).toBe("Database");
  });

  it("colours each bar by its level and links to hosted usage", () => {
    render(
      <PlatformLimitsSection
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
