import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { formatBytes, formatPct } from "@/lib/metrics/format";
import type { PlatformLimitRow } from "@/lib/metrics/rpc-schemas";
import type { HostedUsageLink, MetricResult } from "@/lib/metrics/types";
import { MetricsSection } from "@/app/(app)/admin/stats/metrics-section";
import { MetricResultView } from "@/app/(app)/admin/stats/metric-result-view";
import {
  LIMIT_LEVEL_BADGE,
  LIMIT_LEVEL_TONE,
  resourceLabel,
} from "@/app/(app)/admin/stats/limit-level";

export interface PlatformLimitsSectionProps {
  platformLimits: MetricResult<PlatformLimitRow[]>;
  hostedUsage: HostedUsageLink[];
}

export function PlatformLimitsSection({ platformLimits, hostedUsage }: PlatformLimitsSectionProps) {
  return (
    <MetricsSection
      id="platform-limits"
      title="Platform limits"
      caption="How close is the project to the Supabase Free plan quotas? Warning from 70%, critical from 85%."
    >
      <MetricResultView result={platformLimits}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="text-fg-muted text-sm">No limits reported.</p>
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => {
                const label = resourceLabel(row.resource);
                return (
                  <li key={row.resource} data-testid={`limit-${row.resource}`}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                      <span className="text-fg font-medium">{label}</span>
                      <span className="text-fg-muted flex items-center gap-2 tabular-nums">
                        {formatBytes(row.used_bytes)} of {formatBytes(row.limit_bytes)} (
                        {formatPct(row.pct)})
                        <Badge variant={LIMIT_LEVEL_BADGE[row.level]}>{row.level}</Badge>
                      </span>
                    </div>
                    <ProgressBar
                      value={row.pct / 100}
                      tone={LIMIT_LEVEL_TONE[row.level]}
                      label={`${label} used`}
                    />
                  </li>
                );
              })}
            </ul>
          )
        }
      </MetricResultView>
      <ul className="border-border space-y-1 border-t pt-3 text-sm">
        {hostedUsage.map((link) => (
          <li key={link.provider} className="text-fg">
            {link.provider} — {link.resources}:{" "}
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-600 hover:text-primary-700 underline underline-offset-4"
            >
              See the {link.provider} usage page
            </a>
          </li>
        ))}
      </ul>
    </MetricsSection>
  );
}
