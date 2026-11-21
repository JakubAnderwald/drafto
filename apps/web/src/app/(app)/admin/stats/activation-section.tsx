import { formatCountOf, NOT_AVAILABLE } from "@/lib/metrics/format";
import type { ActivationRow } from "@/lib/metrics/rpc-schemas";
import type { MetricResult } from "@/lib/metrics/types";
import { MetricsSection } from "@/app/(app)/admin/stats/metrics-section";
import { MetricResultView } from "@/app/(app)/admin/stats/metric-result-view";
import { MetricsTable } from "@/app/(app)/admin/stats/metrics-table";

export function ActivationSection({ activation }: { activation: MetricResult<ActivationRow[]> }) {
  return (
    <MetricsSection
      id="activation"
      title="Activation"
      caption="Do new sign-ups get to real use? First value: a 50+ character version within 14 days of sign-up. Activated: such versions on 2+ days."
    >
      <MetricResultView result={activation}>
        {(rows) => (
          <>
            <MetricsTable
              label="Activation by sign-up week"
              emptyText="No sign-up weeks."
              columns={[
                { header: "Cohort" },
                { header: "Starts" },
                { header: "Signed up", numeric: true },
                { header: "First value", numeric: true },
                { header: "Activated", numeric: true },
                { header: "Window" },
              ]}
              rows={rows.map((r) => ({
                key: r.week_start,
                cells: [
                  r.iso_week,
                  r.week_start,
                  r.signed_up,
                  formatCountOf(r.first_value, r.signed_up),
                  r.activated === null
                    ? `${NOT_AVAILABLE}*`
                    : formatCountOf(r.activated, r.signed_up),
                  r.window_complete ? "closed" : "(open)",
                ],
              }))}
            />
            {rows.some((r) => r.activated === null) ? (
              <p className="text-fg-muted text-xs">
                * Too old to count: note history is kept 30 days, so activation can&apos;t be
                measured for this cohort.
              </p>
            ) : null}
          </>
        )}
      </MetricResultView>
    </MetricsSection>
  );
}
