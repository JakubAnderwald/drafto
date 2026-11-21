import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { formatAge, formatHostedAmount, formatPct, formatUtcTimestamp } from "@/lib/metrics/format";
import { hostedResourceLabel } from "@/lib/metrics/hosted-usage-readout";
import type { HostedUsageRow } from "@/lib/metrics/rpc-schemas";
import type { MetricResult } from "@/lib/metrics/types";
import { MetricResultView } from "@/app/(app)/admin/stats/metric-result-view";
import { LIMIT_LEVEL_BADGE, LIMIT_LEVEL_TONE } from "@/app/(app)/admin/stats/limit-level";

export interface HostedUsageListProps {
  readings: MetricResult<HostedUsageRow[]>;
  /** The page's generated-at time, so a reading's age is measured from it. */
  now: string;
}

export const NO_READOUT_TEXT =
  "No dashboard readout yet: the Mac mini reads these on Sunday evening.";

/**
 * The weekly Vercel / Supabase dashboard readings (ADR 0093), as bars against their plan
 * limits. A reading more than 8 days old is marked stale: check the usage page instead.
 */
export function HostedUsageList({ readings, now }: HostedUsageListProps) {
  return (
    <MetricResultView result={readings} unavailableText={NO_READOUT_TEXT}>
      {(rows) =>
        rows.length === 0 ? (
          <p className="text-fg-muted text-sm">{NO_READOUT_TEXT}</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => {
              const label = hostedResourceLabel(row.resource);
              return (
                <li key={row.resource} data-testid={`hosted-${row.resource}`}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                    <span className="text-fg font-medium">{label}</span>
                    <span className="text-fg-muted flex items-center gap-2 tabular-nums">
                      {formatHostedAmount(row.used, row.unit)} of{" "}
                      {formatHostedAmount(row.limit_value, row.unit)} ({formatPct(row.pct)})
                      <Badge variant={LIMIT_LEVEL_BADGE[row.level]}>{row.level}</Badge>
                      {row.stale ? <Badge variant="warning">stale</Badge> : null}
                    </span>
                  </div>
                  <ProgressBar
                    value={row.pct / 100}
                    tone={LIMIT_LEVEL_TONE[row.level]}
                    label={`${label} used`}
                  />
                  <p className="text-fg-muted mt-1 text-xs">
                    Read {formatUtcTimestamp(row.captured_at)} ({formatAge(row.captured_at, now)})
                    {row.period_from && row.period_to
                      ? ` · usage ${row.period_from} to ${row.period_to}`
                      : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        )
      }
    </MetricResultView>
  );
}
