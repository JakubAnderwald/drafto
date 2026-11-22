import { describe, expect, it } from "vitest";
import {
  buildWeeklyReport,
  isoWeekLabel,
  isoWeekStart,
  NOT_TRACKED_YET,
  weeklySubject,
} from "@/lib/metrics/weekly-report";
import { hostedResourceLabel } from "@/lib/metrics/hosted-usage-readout";
import type { ProductMetrics } from "@/lib/metrics/types";
import { emptyMetrics } from "../fixtures/product-metrics";

/** Monday 2026-11-23, 06:00 UTC: the cron's run reporting on 2026-W47. */
const MONDAY = new Date("2026-11-23T06:00:00Z");
const STATS_URL = "https://drafto.eu/admin/stats";

function build(overrides: Partial<ProductMetrics> = {}, now: Date = MONDAY) {
  return buildWeeklyReport({ ...emptyMetrics(), ...overrides }, { now, statsUrl: STATS_URL });
}

const week = (week_start: string, iso_week: string) => ({ week_start, iso_week });

describe("isoWeekLabel / isoWeekStart", () => {
  it.each([
    ["2026-11-23T06:00:00Z", "2026-W48", "2026-11-23"],
    ["2026-11-22T23:59:59Z", "2026-W47", "2026-11-16"],
    ["2026-11-16T00:00:00Z", "2026-W47", "2026-11-16"],
    // Year boundaries: the ISO year is the year of the week's Thursday.
    ["2027-01-01T12:00:00Z", "2026-W53", "2026-12-28"],
    ["2025-12-29T12:00:00Z", "2026-W01", "2025-12-29"],
    ["2021-01-03T12:00:00Z", "2020-W53", "2020-12-28"],
  ])("%s is %s, starting %s", (iso, label, start) => {
    expect(isoWeekLabel(new Date(iso))).toBe(label);
    expect(isoWeekStart(new Date(iso)).toISOString().slice(0, 10)).toBe(start);
  });
});

describe("weeklySubject", () => {
  it("names the ISO week", () => {
    expect(weeklySubject("2026-W47", false)).toBe("Drafto weekly metrics — 2026-W47");
  });

  it("appends needs attention", () => {
    expect(weeklySubject("2026-W47", true)).toBe(
      "Drafto weekly metrics — 2026-W47 — needs attention",
    );
  });
});

describe("buildWeeklyReport", () => {
  it("reports the last complete ISO week against the one before", () => {
    const report = build();
    expect(report.isoWeek).toBe("2026-W47");
    expect(report.weekStart).toBe("2026-11-16");
    expect(report.previousIsoWeek).toBe("2026-W46");
    expect(report.subject).toBe("Drafto weekly metrics — 2026-W47");
    expect(report.statsUrl).toBe(STATS_URL);
  });

  it("reports the same week when run by hand mid-week", () => {
    const report = build({}, new Date("2026-11-26T15:00:00Z"));
    expect(report.isoWeek).toBe("2026-W47");
  });

  it("reads each headline by week, ignoring the week in progress", () => {
    const report = build({
      activeUsers: {
        status: "ok",
        data: [
          {
            ...week("2026-11-23", "2026-W48"),
            active_users: 1,
            writers: 1,
            by_client: {},
            week_complete: false,
          },
          {
            ...week("2026-11-16", "2026-W47"),
            active_users: 6,
            writers: 4,
            by_client: {},
            week_complete: true,
          },
          {
            ...week("2026-11-09", "2026-W46"),
            active_users: 5,
            writers: 2,
            by_client: {},
            week_complete: true,
          },
        ],
      },
      signups: {
        status: "ok",
        data: [
          { ...week("2026-11-23", "2026-W48"), signups: 9, by_provider: {} },
          { ...week("2026-11-16", "2026-W47"), signups: 3, by_provider: {} },
          { ...week("2026-11-09", "2026-W46"), signups: 1, by_provider: {} },
        ],
      },
    });
    expect(report.headlines.slice(0, 3)).toEqual([
      { kind: "value", label: "Weekly active users", current: "6", previous: "5" },
      { kind: "value", label: "Weekly writers", current: "4", previous: "2" },
      { kind: "value", label: "Sign-ups", current: "3", previous: "1" },
    ]);
  });

  it("shows a dash for a week the series doesn't have", () => {
    const report = build({
      signups: {
        status: "ok",
        data: [{ ...week("2026-11-16", "2026-W47"), signups: 1_234, by_provider: {} }],
      },
    });
    expect(report.headlines[2]).toEqual({
      kind: "value",
      label: "Sign-ups",
      current: "1,234",
      previous: "—",
    });
  });

  it("says active users and writers are not tracked yet before #821", () => {
    const report = build({ activeUsers: { status: "unavailable" } });
    expect(report.headlines[0]).toEqual({
      kind: "text",
      label: "Weekly active users",
      text: NOT_TRACKED_YET,
    });
    expect(report.headlines[1]).toEqual({
      kind: "text",
      label: "Weekly writers",
      text: NOT_TRACKED_YET,
    });
  });

  it("says a metric couldn't load and keeps the rest", () => {
    const report = build({
      signups: { status: "error", message: "metrics_signups failed (42501): permission denied" },
    });
    expect(report.headlines[2]).toEqual({
      kind: "text",
      label: "Sign-ups",
      text: "couldn't load: metrics_signups failed (42501): permission denied",
    });
    expect(report.headlines[0].kind).toBe("value");
  });

  it("shows activation for the newest closed cohort beside the one before, as counts", () => {
    const cohort = (
      start: string,
      iso: string,
      signed: number,
      activated: number | null,
      complete: boolean,
    ) => ({
      ...week(start, iso),
      signed_up: signed,
      first_value: signed,
      activated,
      window_complete: complete,
    });
    const report = build({
      activation: {
        status: "ok",
        data: [
          cohort("2026-11-16", "2026-W47", 5, 1, false),
          cohort("2026-11-02", "2026-W45", 3, 1, true),
          cohort("2026-10-26", "2026-W44", 4, 2, true),
        ],
      },
    });
    expect(report.headlines[3]).toEqual({
      kind: "value",
      label: "Activation, cohort 2026-W45",
      current: "1 of 3 (33.3%)",
      previous: "2 of 4 (50%)",
    });
  });

  it("says so when no cohort has closed", () => {
    const report = build();
    expect(report.headlines[3]).toEqual({
      kind: "text",
      label: "Activation, newest closed cohort",
      text: "no cohort has closed yet",
    });
  });

  it("is clear when nothing needs attention", () => {
    const report = build({
      platformLimits: {
        status: "ok",
        data: [{ resource: "database", used_bytes: 100, limit_bytes: 1000, pct: 10, level: "ok" }],
      },
    });
    expect(report.needsAttention).toMatchObject({
      isClear: true,
      emptiedNotes: [],
      moreEmptiedNotes: 0,
      limits: [],
      notes: [],
      emptiedNotesDays: 7,
    });
    expect(report.limits.lines).toEqual([
      { label: "Database", level: "ok", detail: "0 MB of 0 MB", pct: "10%", stale: false },
    ]);
  });

  it("flags emptied notes by note id only, and limits from 70%, worst first", () => {
    const report = build({
      emptiedNotes: {
        status: "ok",
        data: [
          {
            note_id: "11111111-1111-4111-8111-111111111111",
            user_id: "22222222-2222-4222-8222-222222222222",
            emptied_at: "2026-11-18T10:00:00+00:00",
            client: "mobile-ios",
            chars_before: 1234,
          },
        ],
      },
      platformLimits: {
        status: "ok",
        data: [
          {
            resource: "database",
            used_bytes: 104857600,
            limit_bytes: 524288000,
            pct: 20,
            level: "ok",
          },
          {
            resource: "storage",
            used_bytes: 805306368,
            limit_bytes: 1073741824,
            pct: 75,
            level: "warn",
          },
        ],
      },
      hostedReadings: {
        status: "ok",
        data: [
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
            captured_at: "2026-11-22T19:00:00+00:00",
            stale: false,
          },
        ],
      },
    });

    expect(report.subject).toBe("Drafto weekly metrics — 2026-W47 — needs attention");
    expect(report.needsAttention.isClear).toBe(false);
    expect(report.needsAttention.emptiedNotes).toEqual([
      {
        emptiedAt: "2026-11-18 10:00 UTC",
        client: "mobile-ios",
        charsBefore: "1,234",
        noteId: "11111111-1111-4111-8111-111111111111",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(report.needsAttention.limits.map((l) => [l.label, l.level])).toEqual([
      ["Supabase — Egress", "critical"],
      ["Storage", "warn"],
    ]);
    expect(report.limits.lines.map((l) => `${l.label} ${l.pct}`)).toEqual([
      "Database 20%",
      "Storage 75%",
      "Supabase — Egress 85%",
    ]);
  });

  it("lists the newest 20 emptied notes and counts the rest", () => {
    const notes = Array.from({ length: 23 }, (_, i) => ({
      note_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      user_id: "22222222-2222-4222-8222-222222222222",
      emptied_at: "2026-11-18T10:00:00+00:00",
      client: "web",
      chars_before: 10,
    }));
    const report = build({ emptiedNotes: { status: "ok", data: notes } });
    expect(report.needsAttention.emptiedNotes).toHaveLength(20);
    expect(report.needsAttention.emptiedNotes[0].noteId).toBe(notes[0].note_id);
    expect(report.needsAttention.moreEmptiedNotes).toBe(3);
  });

  it("never reports a failed check as clear", () => {
    const report = build({
      emptiedNotes: { status: "error", message: "metrics_emptied_notes failed: timeout" },
      platformLimits: { status: "unavailable" },
    });
    expect(report.needsAttention.isClear).toBe(false);
    expect(report.subject).toMatch(/needs attention$/);
    expect(report.needsAttention.notes).toEqual([
      "Couldn't check emptied notes: metrics_emptied_notes failed: timeout",
      "Couldn't check platform limits: the function isn't on this database",
    ]);
    expect(report.limits.notes).toEqual(["Supabase limits: not shown, see Needs attention."]);
  });

  it("flags a stale hosting readout and marks stale readings", () => {
    const report = build({
      hostedReadings: {
        status: "ok",
        data: [
          {
            provider: "vercel",
            resource: "vercel_active_cpu",
            unit: "hours",
            used: 1,
            limit_value: 4,
            pct: 25,
            level: "ok",
            period_from: null,
            period_to: null,
            captured_at: "2026-11-08T19:00:00+00:00",
            stale: true,
          },
        ],
      },
    });
    expect(report.needsAttention.notes).toEqual([
      "The weekly hosting-usage readout hasn't run since 2026-11-08 19:00 UTC.",
    ]);
    expect(report.limits.lines[0]).toMatchObject({ detail: "1h of 4h", stale: true });
  });

  it("flags and lists every hosted-usage row, Supabase log ingestion over its limit included", () => {
    const reading = (
      resource: string,
      used: number,
      limit: number,
      pct: number,
      level: "ok" | "warn" | "critical",
    ) => ({
      provider: "supabase" as const,
      resource,
      unit: "GB" as const,
      used,
      limit_value: limit,
      pct,
      level,
      period_from: "2026-10-25",
      period_to: null,
      captured_at: "2026-11-22T19:00:00+00:00",
      stale: false,
    });
    const report = build({
      hostedReadings: {
        status: "ok",
        data: [
          reading("supabase_egress", 1, 5, 20, "ok"),
          reading("supabase_log_ingestion", 1.02, 1, 102, "critical"),
        ],
      },
    });
    // The label comes from the readout's resource registry (#904 adds log ingestion to it).
    const label = hostedResourceLabel("supabase_log_ingestion");
    const line = { label, level: "critical", detail: "1.02 GB of 1 GB", pct: "102%", stale: false };
    expect(report.needsAttention.limits).toEqual([line]);
    expect(report.subject).toMatch(/needs attention$/);
    expect(report.limits.lines.map((l) => l.label)).toEqual([
      hostedResourceLabel("supabase_egress"),
      label,
    ]);
    expect(report.limits.lines[1]).toEqual(line);
  });

  it("notes a hosting readout that failed to load", () => {
    const report = build({ hostedReadings: { status: "error", message: "boom" } });
    expect(report.limits.notes).toEqual(["Hosting usage: not shown, see Needs attention."]);
    expect(report.needsAttention.notes).toEqual(["Couldn't check hosting usage: boom"]);
  });
});
