import { describe, expect, it } from "vitest";
import { weeklyMetricsEmail } from "@/lib/email/weekly-metrics-email";
import type { WeeklyReport } from "@/lib/metrics/weekly-report";

function report(overrides: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    isoWeek: "2026-W47",
    weekStart: "2026-11-16",
    previousIsoWeek: "2026-W46",
    subject: "Drafto weekly metrics — 2026-W47",
    generatedAt: "2026-11-23T06:00:00.000Z",
    needsAttention: {
      isClear: true,
      emptiedNotesDays: 7,
      emptiedNotes: [],
      moreEmptiedNotes: 0,
      limits: [],
      notes: [],
    },
    headlines: [
      { kind: "value", label: "Weekly active users", current: "6", previous: "5" },
      { kind: "text", label: "Weekly writers", text: "not tracked yet" },
      { kind: "value", label: "Sign-ups", current: "3", previous: "1" },
      {
        kind: "value",
        label: "Activation, cohort 2026-W45",
        current: "1 of 3 (33.3%)",
        previous: "2 of 4 (50%)",
      },
    ],
    limits: {
      lines: [
        { label: "Database", level: "ok", detail: "100 MB of 500 MB", pct: "20%", stale: false },
        {
          label: "Vercel — Active CPU",
          level: "ok",
          detail: "1h of 4h",
          pct: "25%",
          stale: true,
        },
      ],
      notes: [],
    },
    statsUrl: "https://drafto.eu/admin/stats",
    ...overrides,
  };
}

const ATTENTION: WeeklyReport["needsAttention"] = {
  isClear: false,
  emptiedNotesDays: 7,
  emptiedNotes: [
    {
      emptiedAt: "2026-11-18 10:00 UTC",
      client: "web",
      charsBefore: "1,234",
      noteId: "11111111-1111-4111-8111-111111111111",
    },
  ],
  moreEmptiedNotes: 0,
  limits: [{ label: "Storage", level: "warn", detail: "768 MB of 1 GB", pct: "75%", stale: false }],
  notes: ["Couldn't check platform limits: boom"],
};

describe("weeklyMetricsEmail", () => {
  it("uses the report's subject", () => {
    expect(weeklyMetricsEmail(report()).subject).toBe("Drafto weekly metrics — 2026-W47");
  });

  it("puts the sections in order: needs attention, headlines, limits, link", () => {
    const { html, text } = weeklyMetricsEmail(report());
    const order = ["Needs attention", "Headline numbers", "Platform limits", "/admin/stats"];
    const positions = order.map((s) => html.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    const textOrder = ["NEEDS ATTENTION", "HEADLINE NUMBERS", "PLATFORM LIMITS", "All metrics:"];
    const textPositions = textOrder.map((s) => text.indexOf(s));
    expect(textPositions.every((p) => p >= 0)).toBe(true);
    expect([...textPositions].sort((a, b) => a - b)).toEqual(textPositions);
  });

  it("says nothing needs attention, with no warning background, when clear", () => {
    const { html, text } = weeklyMetricsEmail(report());
    expect(html).toContain("Nothing needs attention.");
    expect(html).not.toContain("#fff4e0");
    expect(text).toContain("NEEDS ATTENTION\nNothing needs attention.");
  });

  it("shows emptied notes, limits and notes on a warning background when not clear", () => {
    const { html, text } = weeklyMetricsEmail(report({ needsAttention: ATTENTION }));
    expect(html).toContain("background:#fff4e0");
    expect(html).toContain("Notes a single save emptied in the last 7 days:");
    expect(html).toContain("11111111-1111-4111-8111-111111111111");
    expect(html).toContain("768 MB of 1 GB");
    expect(html).toContain("Couldn&#39;t check platform limits: boom");
    expect(text).toContain(
      "- 2026-11-18 10:00 UTC, web, 1,234 characters before, note 11111111-1111-4111-8111-111111111111",
    );
    expect(text).toContain("- Storage: 768 MB of 1 GB (75%), warn");
    expect(html).not.toContain("Nothing needs attention");
  });

  it("points to /admin/stats for emptied notes beyond those listed", () => {
    const { html, text } = weeklyMetricsEmail(
      report({ needsAttention: { ...ATTENTION, moreEmptiedNotes: 5 } }),
    );
    expect(html).toContain("…and 5 more notes: see https://drafto.eu/admin/stats");
    expect(text).toContain("…and 5 more notes: see https://drafto.eu/admin/stats");
  });

  it("shows each headline with last week's value", () => {
    const { html, text } = weeklyMetricsEmail(report());
    expect(text).toContain("- Weekly active users: 6 (week before: 5)");
    expect(text).toContain("- Weekly writers: not tracked yet");
    expect(text).toContain(
      "- Activation, cohort 2026-W45: 1 of 3 (33.3%) (week before: 2 of 4 (50%))",
    );
    expect(html).toContain(">This week</th>");
    expect(html).toContain(">Week before</th>");
    expect(html).toContain("compared with 2026-W46");
    expect(html).toContain("not tracked yet");
  });

  it("lists every platform limit as a percentage, marking stale readings", () => {
    const { html, text } = weeklyMetricsEmail(report());
    expect(text).toContain("- Database: 100 MB of 500 MB (20%), ok");
    expect(text).toContain("- Vercel — Active CPU: 1h of 4h (25%), ok, stale");
    expect(html).toContain("(stale)");
    expect(html).toMatch(/text-align:right[^>]*>20%</);
  });

  it("says when no limits were reported, and why a set is missing", () => {
    const { text } = weeklyMetricsEmail(
      report({
        limits: { lines: [], notes: ["Supabase limits: not shown, see Needs attention."] },
      }),
    );
    expect(text).toContain(
      "PLATFORM LIMITS\nNo limits reported.\nSupabase limits: not shown, see Needs attention.",
    );
  });

  it("links to /admin/stats", () => {
    const { html, text } = weeklyMetricsEmail(report());
    expect(html).toContain('href="https://drafto.eu/admin/stats"');
    expect(text).toContain("All metrics: https://drafto.eu/admin/stats");
  });

  it("escapes values and has no images, fonts or tracking pixels", () => {
    const { html } = weeklyMetricsEmail(
      report({
        needsAttention: {
          ...ATTENTION,
          emptiedNotes: [{ ...ATTENTION.emptiedNotes[0], client: "<script>x</script>" }],
        },
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<img|@font-face|fonts\.googleapis|<link /i);
  });

  it("contains no email address", () => {
    const { html, text } = weeklyMetricsEmail(report({ needsAttention: ATTENTION }));
    for (const body of [html, text]) {
      expect(body).not.toMatch(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i);
    }
  });
});
