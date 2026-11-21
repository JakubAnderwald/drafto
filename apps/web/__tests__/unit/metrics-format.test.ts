import { describe, expect, it } from "vitest";
import {
  ACTIVE_CLIENT_COLUMNS,
  CLIENT_COLUMNS,
  columnsFor,
  formatBytes,
  formatCountOf,
  formatNumber,
  formatPct,
  formatUtcTimestamp,
  formatHostedAmount,
  formatAge,
} from "@/lib/metrics/format";
import { hostedUsageLinks } from "@/lib/metrics/hosted-usage";

describe("metrics format", () => {
  it("shows counts with every rate", () => {
    expect(formatCountOf(1, 8)).toBe("1 of 8 (12.5%)");
    expect(formatCountOf(2, 3)).toBe("2 of 3 (66.7%)");
    expect(formatCountOf(0, 0)).toBe("0 of 0");
    expect(formatCountOf(null, 5)).toBe("—");
    expect(formatCountOf(undefined, 5)).toBe("—");
  });

  it("formats percentages and placeholders", () => {
    expect(formatPct(12.5)).toBe("12.5%");
    expect(formatPct(100)).toBe("100%");
    expect(formatPct(null)).toBe("—");
    expect(formatPct(Number.NaN)).toBe("—");
  });

  it("uses binary units", () => {
    expect(formatBytes(500 * 1024 * 1024)).toBe("500 MB");
    expect(formatBytes(123.45 * 1024 * 1024)).toBe("123.5 MB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.25 GB");
    expect(formatBytes(0)).toBe("0 MB");
  });

  it("formats numbers", () => {
    expect(formatNumber(12.25)).toBe("12.3");
    expect(formatNumber(12.25, 2)).toBe("12.25");
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(null)).toBe("—");
  });

  it("formats UTC timestamps", () => {
    expect(formatUtcTimestamp("2026-11-21T08:05:30.123Z")).toBe("2026-11-21 08:05 UTC");
    expect(formatUtcTimestamp("2026-11-18T10:00:00+00:00")).toBe("2026-11-18 10:00 UTC");
    expect(formatUtcTimestamp("not a date")).toBe("not a date");
  });

  it("orders client columns like the CLI", () => {
    expect(ACTIVE_CLIENT_COLUMNS).toEqual([
      "web",
      "mobile-ios",
      "mobile-android",
      "desktop-macos",
      "web-mcp",
    ]);
    expect(CLIENT_COLUMNS).toEqual([...ACTIVE_CLIENT_COLUMNS, "untagged"]);
  });

  it("lists known columns first, then the others seen", () => {
    const objects: (Record<string, number> | null)[] = [
      { web: 1, zeta: 1 },
      { "mobile-ios": 2, alpha: 1 },
      null,
    ];
    expect(columnsFor(objects, ["web", "mobile-ios", "web-mcp"])).toEqual([
      "web",
      "mobile-ios",
      "alpha",
      "zeta",
    ]);
    expect(columnsFor(objects, ["web", "web-mcp"], { always: true })).toEqual([
      "web",
      "web-mcp",
      "alpha",
      "mobile-ios",
      "zeta",
    ]);
    expect(columnsFor([], ["email"])).toEqual([]);
  });

  it("links to the providers' usage pages", () => {
    const links = hostedUsageLinks();
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.href).toMatch(/^https:\/\//);
  });

  it("formats hosting usage in its dashboard unit", () => {
    expect(formatHostedAmount(1.42, "GB")).toBe("1.42 GB");
    expect(formatHostedAmount(195000, "count")).toBe("195,000");
    expect(formatHostedAmount(2.2833, "hours")).toBe("2h 17m");
    expect(formatHostedAmount(4, "hours")).toBe("4h");
    expect(formatHostedAmount(Number.NaN, "GB")).toBe("—");
  });

  it("says how old a reading is", () => {
    const now = "2026-11-21T08:00:00.000Z";
    expect(formatAge("2026-11-21T07:00:00.000Z", now)).toBe("today");
    // Calendar days, not 24-hour periods: Sunday evening seen on Monday morning.
    expect(formatAge("2026-11-20T20:00:00.000Z", now)).toBe("1 day ago");
    expect(formatAge("2026-11-20T07:00:00.000Z", now)).toBe("1 day ago");
    expect(formatAge("2026-11-12T07:00:00.000Z", now)).toBe("9 days ago");
    expect(formatAge("nope", now)).toBe("—");
  });
});
