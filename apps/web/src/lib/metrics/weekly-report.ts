import {
  formatBytes,
  formatCountOf,
  formatHostedAmount,
  formatPct,
  formatUtcTimestamp,
  NOT_AVAILABLE,
  resourceLabel,
} from "@/lib/metrics/format";
import { hostedResourceLabel } from "@/lib/metrics/hosted-usage-readout";
import { deriveNeedsAttention } from "@/lib/metrics/needs-attention";
import type {
  ActivationRow,
  HostedUsageRow,
  PlatformLimitLevel,
  PlatformLimitRow,
} from "@/lib/metrics/rpc-schemas";
import type { MetricResult, ProductMetrics } from "@/lib/metrics/types";

/**
 * The Monday metrics email (#823) as data: what it says, already formatted, with no
 * markup. `weekly-metrics-email.ts` lays it out as HTML and text. Nothing is stored
 * between runs: "this week" and "last week" both come from the metric functions'
 * weekly series.
 *
 * The report carries no user id, email, note text, title or notebook name. Emptied
 * notes are identified by note id only.
 */

/** Emptied notes in the email: the last 7 days (the page shows 14). */
export const WEEKLY_EMPTIED_NOTES_DAYS = 7;

/** Shown for a weekly metric whose function isn't on the database yet (before #821). */
export const NOT_TRACKED_YET = "not tracked yet";

/** Emptied notes listed in the email; the rest are counted, and listed on /admin/stats. */
export const MAX_EMPTIED_NOTES_LISTED = 20;

const DAY_MS = 86_400_000;

const LEVEL_RANK: Record<PlatformLimitLevel, number> = { critical: 0, warn: 1, ok: 2 };

export interface EmptiedNoteLine {
  /** "2026-11-18 10:00 UTC". */
  emptiedAt: string;
  client: string;
  charsBefore: string;
  noteId: string;
}

export interface LimitLine {
  label: string;
  level: PlatformLimitLevel;
  /** "768 MB of 1 GB". */
  detail: string;
  /** "75%". */
  pct: string;
  /** A weekly dashboard reading more than 8 days old. */
  stale: boolean;
}

export type HeadlineLine =
  | { kind: "value"; label: string; current: string; previous: string }
  | { kind: "text"; label: string; text: string };

export interface WeeklyReport {
  /** The ISO week reported on: the last complete one, e.g. "2026-W47". */
  isoWeek: string;
  /** Its Monday, "YYYY-MM-DD". */
  weekStart: string;
  /** The ISO week compared against, e.g. "2026-W46". */
  previousIsoWeek: string;
  subject: string;
  generatedAt: string;
  needsAttention: {
    isClear: boolean;
    emptiedNotesDays: number;
    /** The newest `MAX_EMPTIED_NOTES_LISTED` emptied notes. */
    emptiedNotes: EmptiedNoteLine[];
    /** Emptied notes in the window beyond those listed. */
    moreEmptiedNotes: number;
    limits: LimitLine[];
    /** A stale readout, and every check that couldn't run. */
    notes: string[];
  };
  headlines: HeadlineLine[];
  limits: {
    lines: LimitLine[];
    /** Why a set of limits is missing. */
    notes: string[];
  };
  statsUrl: string;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Monday 00:00 UTC of the ISO week containing `date`. */
export function isoWeekStart(date: Date): Date {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const daysSinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return new Date(midnight - daysSinceMonday * DAY_MS);
}

/** The ISO 8601 week of `date` in UTC, as the SQL's `to_char(…, 'IYYY-"W"IW')`: "2026-W47". */
export function isoWeekLabel(date: Date): string {
  // The ISO year is the year of the week's Thursday.
  const thursday = new Date(isoWeekStart(date).getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function weeklySubject(isoWeek: string, needsAttention: boolean): string {
  return `Drafto weekly metrics — ${isoWeek}${needsAttention ? " — needs attention" : ""}`;
}

function failureText(result: MetricResult<unknown>, unavailable: string): string {
  if (result.status === "error") return `couldn't load: ${result.message}`;
  return unavailable;
}

/** One weekly series' value for the reported week and the one before, read by `week_start`. */
function weeklyLine<Row extends { week_start: string }>(
  label: string,
  result: MetricResult<Row[]>,
  value: (row: Row) => number,
  weeks: { current: string; previous: string },
  unavailable: string,
): HeadlineLine {
  if (result.status !== "ok") {
    return { kind: "text", label, text: failureText(result, unavailable) };
  }
  const pick = (weekStart: string) => {
    const row = result.data.find((r) => r.week_start === weekStart);
    return row ? value(row).toLocaleString("en-US") : NOT_AVAILABLE;
  };
  return { kind: "value", label, current: pick(weeks.current), previous: pick(weeks.previous) };
}

function activationCount(row: ActivationRow | undefined): string {
  if (!row) return NOT_AVAILABLE;
  return formatCountOf(row.activated, row.signed_up);
}

/**
 * The newest cohort whose 14-day window has closed, beside the cohort before it (the
 * week before, as sign-up cohorts are weekly).
 */
function activationLine(result: MetricResult<ActivationRow[]>): HeadlineLine {
  const label = "Activation, newest closed cohort";
  if (result.status !== "ok") {
    return { kind: "text", label, text: failureText(result, NOT_TRACKED_YET) };
  }
  const closed = result.data.filter((r) => r.window_complete);
  const [current, previous] = closed;
  if (!current) return { kind: "text", label, text: "no cohort has closed yet" };
  return {
    kind: "value",
    label: `Activation, cohort ${current.iso_week}`,
    current: activationCount(current),
    previous: activationCount(previous),
  };
}

function platformLimitLine(row: PlatformLimitRow): LimitLine {
  return {
    label: resourceLabel(row.resource),
    level: row.level,
    detail: `${formatBytes(row.used_bytes)} of ${formatBytes(row.limit_bytes)}`,
    pct: formatPct(row.pct),
    stale: false,
  };
}

function hostedLimitLine(row: HostedUsageRow): LimitLine {
  return {
    label: hostedResourceLabel(row.resource),
    level: row.level,
    detail: `${formatHostedAmount(row.used, row.unit)} of ${formatHostedAmount(row.limit_value, row.unit)}`,
    pct: formatPct(row.pct),
    stale: row.stale,
  };
}

function okRows<T>(result: MetricResult<T[]>): T[] {
  return result.status === "ok" ? result.data : [];
}

export interface BuildWeeklyReportOptions {
  /** The run's time. The report covers the last ISO week that ended before it. */
  now: Date;
  /** The link at the end: `${APP_URL}/admin/stats`. */
  statsUrl: string;
  /** The window the metrics' emptied notes were read for. */
  emptiedNotesDays?: number;
}

export function buildWeeklyReport(
  metrics: ProductMetrics,
  { now, statsUrl, emptiedNotesDays = WEEKLY_EMPTIED_NOTES_DAYS }: BuildWeeklyReportOptions,
): WeeklyReport {
  const thisWeekStart = isoWeekStart(now);
  const reported = new Date(thisWeekStart.getTime() - 7 * DAY_MS);
  const compared = new Date(thisWeekStart.getTime() - 14 * DAY_MS);
  const weeks = { current: isoDate(reported), previous: isoDate(compared) };
  const isoWeek = isoWeekLabel(reported);

  const attention = deriveNeedsAttention(metrics);
  // Worst first across both sources, as the page ranks each list: level, then percentage.
  const flagged = [
    ...attention.limits.map((row) => ({ row, line: platformLimitLine(row) })),
    ...attention.hostedLimits.map((row) => ({ row, line: hostedLimitLine(row) })),
  ]
    .sort((a, b) => LEVEL_RANK[a.row.level] - LEVEL_RANK[b.row.level] || b.row.pct - a.row.pct)
    .map(({ line }) => line);

  const attentionNotes = [
    ...(attention.readoutStaleSince
      ? [
          `The weekly hosting-usage readout hasn't run since ${formatUtcTimestamp(attention.readoutStaleSince)}.`,
        ]
      : []),
    ...attention.unchecked.map((u) => `Couldn't check ${u.check.toLowerCase()}: ${u.reason}`),
  ];

  // Why a set of limits is missing: the cause itself is under Needs attention.
  const limitNotes: string[] = [];
  if (metrics.platformLimits.status !== "ok") {
    limitNotes.push("Supabase limits: not shown, see Needs attention.");
  }
  if (metrics.hostedReadings.status === "error") {
    limitNotes.push("Hosting usage: not shown, see Needs attention.");
  }

  return {
    isoWeek,
    weekStart: weeks.current,
    previousIsoWeek: isoWeekLabel(compared),
    subject: weeklySubject(isoWeek, !attention.isClear),
    generatedAt: metrics.generatedAt,
    needsAttention: {
      isClear: attention.isClear,
      emptiedNotesDays,
      emptiedNotes: attention.emptiedNotes.slice(0, MAX_EMPTIED_NOTES_LISTED).map((n) => ({
        emptiedAt: formatUtcTimestamp(n.emptied_at),
        client: n.client,
        charsBefore: n.chars_before.toLocaleString("en-US"),
        noteId: n.note_id,
      })),
      moreEmptiedNotes: Math.max(0, attention.emptiedNotes.length - MAX_EMPTIED_NOTES_LISTED),
      limits: flagged,
      notes: attentionNotes,
    },
    headlines: [
      weeklyLine(
        "Weekly active users",
        metrics.activeUsers,
        (r) => r.active_users,
        weeks,
        NOT_TRACKED_YET,
      ),
      weeklyLine("Weekly writers", metrics.activeUsers, (r) => r.writers, weeks, NOT_TRACKED_YET),
      weeklyLine("Sign-ups", metrics.signups, (r) => r.signups, weeks, NOT_TRACKED_YET),
      activationLine(metrics.activation),
    ],
    limits: {
      lines: [
        ...okRows(metrics.platformLimits).map(platformLimitLine),
        ...okRows(metrics.hostedReadings).map(hostedLimitLine),
      ],
      notes: limitNotes,
    },
    statsUrl,
  };
}
