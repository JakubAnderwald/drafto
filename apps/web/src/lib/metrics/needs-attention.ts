import type { EmptiedNoteRow, PlatformLimitRow } from "@/lib/metrics/rpc-schemas";
import type { ProductMetrics } from "@/lib/metrics/types";

export interface NeedsAttention {
  /** Notes a single save emptied in the window. */
  emptiedNotes: EmptiedNoteRow[];
  /** Platform limits at `warn` or `critical`, worst first. */
  limits: PlatformLimitRow[];
  /** Checks that couldn't run, so "nothing needs attention" can't be claimed for them. */
  unchecked: string[];
  /** True only when every check ran and found nothing. */
  isClear: boolean;
}

const LEVEL_RANK: Record<PlatformLimitRow["level"], number> = { critical: 0, warn: 1, ok: 2 };

/** What the page's first section, and the Monday email, flag. */
export function deriveNeedsAttention(
  metrics: Pick<ProductMetrics, "emptiedNotes" | "platformLimits">,
): NeedsAttention {
  const unchecked: string[] = [];
  const emptiedNotes = metrics.emptiedNotes.status === "ok" ? metrics.emptiedNotes.data : [];
  if (metrics.emptiedNotes.status !== "ok") unchecked.push("Emptied notes");

  const limits =
    metrics.platformLimits.status === "ok"
      ? metrics.platformLimits.data
          .filter((row) => row.level !== "ok")
          .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.pct - a.pct)
      : [];
  if (metrics.platformLimits.status !== "ok") unchecked.push("Platform limits");

  return {
    emptiedNotes,
    limits,
    unchecked,
    isClear: unchecked.length === 0 && emptiedNotes.length === 0 && limits.length === 0,
  };
}
