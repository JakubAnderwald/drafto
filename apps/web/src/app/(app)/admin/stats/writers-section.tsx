import { Badge } from "@/components/ui/badge";
import { CLIENT_COLUMNS, columnsFor } from "@/lib/metrics/format";
import type { WritersRow } from "@/lib/metrics/rpc-schemas";
import type { MetricResult } from "@/lib/metrics/types";
import { MetricsSection } from "@/app/(app)/admin/stats/metrics-section";
import { MetricResultView } from "@/app/(app)/admin/stats/metric-result-view";
import { MetricsTable } from "@/app/(app)/admin/stats/metrics-table";

export function WritersSection({ writers }: { writers: MetricResult<WritersRow[]> }) {
  return (
    <MetricsSection
      id="writers"
      title="Writers"
      caption={
        "Where should engineering time go? Writers per week by client; a user writing from two clients counts once in Writers and under each client."
      }
    >
      <MetricResultView result={writers}>
        {(rows) => {
          const clients = columnsFor(
            rows.map((r) => r.by_client),
            CLIENT_COLUMNS,
            { always: true },
          );
          return (
            <MetricsTable
              label="Writers per ISO week"
              emptyText="No weeks."
              columns={[
                { header: "Week" },
                { header: "Starts" },
                { header: "Writers", numeric: true },
                ...clients.map((c) => ({ header: c, numeric: true })),
                { header: "History" },
              ]}
              rows={rows.map((r) => ({
                key: r.week_start,
                cells: [
                  r.iso_week,
                  r.week_start,
                  r.writers,
                  ...clients.map((c) => r.by_client[c] ?? 0),
                  r.history_complete ? (
                    "complete"
                  ) : (
                    <Badge key="history" variant="warning">
                      partial
                    </Badge>
                  ),
                ],
              }))}
            />
          );
        }}
      </MetricResultView>
    </MetricsSection>
  );
}
