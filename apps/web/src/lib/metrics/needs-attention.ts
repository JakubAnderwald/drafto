import type { EmptiedNoteRow, HostedUsageRow, PlatformLimitRow } from "@/lib/metrics/rpc-schemas";
import type { MetricResult, ProductMetrics } from "@/lib/metrics/types";

export interface UncheckedCheck {
  check: "Emptied notes" | "Platform limits" | "Hosting usage";
  /** The metric's error message, or why it is unavailable. */
  reason: string;
}

export interface NeedsAttention {
  /** Notes a single save emptied in the window. */
  emptiedNotes: EmptiedNoteRow[];
  /** Platform limits at `warn` or `critical`, worst first. */
  limits: PlatformLimitRow[];
  /** Vercel / Supabase readings at `warn` or `critical`, worst first (ADR 0091). */
  hostedLimits: HostedUsageRow[];
  /**
   * When every reading is more than 8 days old, the newest one's time: the weekly readout
   * hasn't run since. Null while any reading is fresh, or there are none. One resource gone
   * stale while the rest are fresh (it dropped out of the dashboard) shows only as a badge.
   */
  readoutStaleSince: string | null;
  /** Checks that couldn't run, so "nothing needs attention" can't be claimed for them. */
  unchecked: UncheckedCheck[];
  /** True only when every check ran and found nothing. */
  isClear: boolean;
}

const UNAVAILABLE_REASON = "the function isn't on this database";

function reasonOf(result: MetricResult<unknown>): string {
  return result.status === "error" ? result.message : UNAVAILABLE_REASON;
}

const LEVEL_RANK: Record<PlatformLimitRow["level"], number> = { critical: 0, warn: 1, ok: 2 };

/** What the page's first section, and the Monday email, flag. */
export function deriveNeedsAttention(
  metrics: Pick<ProductMetrics, "emptiedNotes" | "platformLimits" | "hostedReadings">,
): NeedsAttention {
  const unchecked: UncheckedCheck[] = [];
  const emptiedNotes = metrics.emptiedNotes.status === "ok" ? metrics.emptiedNotes.data : [];
  if (metrics.emptiedNotes.status !== "ok") {
    unchecked.push({ check: "Emptied notes", reason: reasonOf(metrics.emptiedNotes) });
  }

  const limits =
    metrics.platformLimits.status === "ok"
      ? metrics.platformLimits.data
          .filter((row) => row.level !== "ok")
          .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.pct - a.pct)
      : [];
  if (metrics.platformLimits.status !== "ok") {
    unchecked.push({ check: "Platform limits", reason: reasonOf(metrics.platformLimits) });
  }

  // A readout never set up (the function missing on this database) isn't flagged: the page
  // links to the usage pages instead. A failing one is.
  const readings = metrics.hostedReadings.status === "ok" ? metrics.hostedReadings.data : [];
  if (metrics.hostedReadings.status === "error") {
    unchecked.push({ check: "Hosting usage", reason: metrics.hostedReadings.message });
  }
  const hostedLimits = readings
    .filter((row) => row.level !== "ok")
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.pct - a.pct);
  const readoutStaleSince =
    readings.length > 0 && readings.every((row) => row.stale)
      ? readings.reduce((newest, row) => (row.captured_at > newest ? row.captured_at : newest), "")
      : null;

  return {
    emptiedNotes,
    limits,
    hostedLimits,
    readoutStaleSince,
    unchecked,
    isClear:
      unchecked.length === 0 &&
      emptiedNotes.length === 0 &&
      limits.length === 0 &&
      hostedLimits.length === 0 &&
      readoutStaleSince === null,
  };
}
