import { formatCountOf, formatNumber } from "@/lib/metrics/format";
import type { DepthMetrics, DepthShare, MetricResult } from "@/lib/metrics/types";
import { MetricsSection } from "@/app/(app)/admin/stats/metrics-section";
import { MetricResultView } from "@/app/(app)/admin/stats/metric-result-view";
import { MetricsTable } from "@/app/(app)/admin/stats/metrics-table";

function shareCell(share: DepthShare): string {
  return formatCountOf(share.count, share.of);
}

export function DepthSection({ depth }: { depth: MetricResult<DepthMetrics | null> }) {
  return (
    <MetricsSection
      id="depth"
      title="Depth"
      caption="How deeply do the last 30 days' writers use Drafto?"
    >
      <MetricResultView result={depth}>
        {(d) =>
          d === null ? (
            <p className="text-fg-muted text-sm">No depth figures.</p>
          ) : (
            <>
              <p className="text-fg text-sm">
                Writers in the last 30 days: <span className="font-semibold">{d.writers}</span>
              </p>
              <MetricsTable
                label="Per writer"
                columns={[
                  { header: "Per writer" },
                  { header: "Median", numeric: true },
                  { header: "Max", numeric: true },
                ]}
                rows={[
                  {
                    key: "notes",
                    cells: [
                      "Live notes",
                      formatNumber(d.live_notes_median),
                      formatNumber(d.live_notes_max),
                    ],
                  },
                  {
                    key: "notebooks",
                    cells: [
                      "Notebooks",
                      formatNumber(d.notebooks_median),
                      formatNumber(d.notebooks_max),
                    ],
                  },
                  {
                    key: "attachments",
                    cells: [
                      "Attachments (MB)",
                      formatNumber(d.attachment_mb_median, 2),
                      formatNumber(d.attachment_mb_max, 2),
                    ],
                  },
                ]}
              />
              <MetricsTable
                label="Share of writers"
                columns={[{ header: "Share of writers" }, { header: "Writers", numeric: true }]}
                rows={[
                  { key: "attachment", cells: ["With an attachment", shareCell(d.withAttachment)] },
                  { key: "api-key", cells: ["With an API key", shareCell(d.withApiKey)] },
                  { key: "mcp", cells: ["With an MCP write", shareCell(d.withMcpWrite)] },
                  { key: "multi", cells: ["Writing from 2+ clients", shareCell(d.multiClient)] },
                ]}
              />
            </>
          )
        }
      </MetricResultView>
    </MetricsSection>
  );
}
