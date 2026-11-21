import type { EmptiedNoteRow, PlatformLimitRow } from "@/lib/metrics/rpc-schemas";
import type { MetricResult, ProductMetrics } from "@/lib/metrics/types";

export interface UncheckedCheck {
  check: "Emptied notes" | "Platform limits";
  /** The metric's error message, or why it is unavailable. */
  reason: string;
}

export interface NeedsAttention {
  /** Notes a single save emptied in the window. */
  emptiedNotes: EmptiedNoteRow[];
  /** Platform limits at `warn` or `critical`, worst first. */
  limits: PlatformLimitRow[];
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
  metrics: Pick<ProductMetrics, "emptiedNotes" | "platformLimits">,
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

  return {
    emptiedNotes,
    limits,
    unchecked,
    isClear: unchecked.length === 0 && emptiedNotes.length === 0 && limits.length === 0,
  };
}
