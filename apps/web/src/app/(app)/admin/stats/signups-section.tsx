import { columnsFor, PROVIDER_COLUMNS } from "@/lib/metrics/format";
import type { SignupsRow } from "@/lib/metrics/rpc-schemas";
import type { MetricResult } from "@/lib/metrics/types";
import { MetricsSection } from "@/app/(app)/admin/stats/metrics-section";
import { MetricResultView } from "@/app/(app)/admin/stats/metric-result-view";
import { MetricsTable } from "@/app/(app)/admin/stats/metrics-table";

export function SignupsSection({ signups }: { signups: MetricResult<SignupsRow[]> }) {
  return (
    <MetricsSection
      id="signups"
      title="Sign-ups"
      caption="How many accounts are created each week, and with which sign-in method?"
    >
      <MetricResultView result={signups}>
        {(rows) => {
          const providers = columnsFor(
            rows.map((r) => r.by_provider),
            PROVIDER_COLUMNS,
          );
          return (
            <MetricsTable
              label="Sign-ups per ISO week"
              emptyText="No weeks."
              columns={[
                { header: "Week" },
                { header: "Starts" },
                { header: "Sign-ups", numeric: true },
                ...providers.map((p) => ({ header: p, numeric: true })),
              ]}
              rows={rows.map((r) => ({
                key: r.week_start,
                cells: [
                  r.iso_week,
                  r.week_start,
                  r.signups,
                  ...providers.map((p) => r.by_provider[p] ?? 0),
                ],
              }))}
            />
          );
        }}
      </MetricResultView>
    </MetricsSection>
  );
}
