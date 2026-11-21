import {
  ACTIVE_CLIENT_COLUMNS,
  columnsFor,
  formatCountOf,
  NOT_AVAILABLE,
} from "@/lib/metrics/format";
import type { ActiveUsersRow, RetentionRow } from "@/lib/metrics/rpc-schemas";
import type { MetricResult } from "@/lib/metrics/types";
import { MetricsSection } from "@/app/(app)/admin/stats/metrics-section";
import { MetricResultView } from "@/app/(app)/admin/stats/metric-result-view";
import { MetricsTable } from "@/app/(app)/admin/stats/metrics-table";

export const USAGE_TRACKING_PENDING = "Available after usage tracking ships";

export interface ActiveUsersSectionProps {
  activeUsers: MetricResult<ActiveUsersRow[]>;
  retention: MetricResult<RetentionRow[]>;
}

function retentionCell(active: number | null, activated: number | null): string {
  if (activated === null || active === null) return NOT_AVAILABLE;
  return formatCountOf(active, activated);
}

export function ActiveUsersSection({ activeUsers, retention }: ActiveUsersSectionProps) {
  return (
    <MetricsSection
      id="active-users"
      title="Active users and retention"
      caption="How many people open Drafto each week, and do activated users come back 7–13 and 28–34 days after signing up?"
    >
      <MetricResultView result={activeUsers} unavailableText={USAGE_TRACKING_PENDING}>
        {(rows) => {
          const clients = columnsFor(
            rows.map((r) => r.by_client),
            ACTIVE_CLIENT_COLUMNS,
            { always: true },
          );
          return (
            <MetricsTable
              label="Active users per ISO week"
              emptyText="No weeks."
              columns={[
                { header: "Week" },
                { header: "Starts" },
                { header: "Active users", numeric: true },
                { header: "Writers", numeric: true },
                ...clients.map((c) => ({ header: c, numeric: true })),
                { header: "Status" },
              ]}
              rows={rows.map((r) => ({
                key: r.week_start,
                cells: [
                  r.iso_week,
                  r.week_start,
                  r.active_users,
                  formatCountOf(r.writers, r.active_users),
                  ...clients.map((c) => r.by_client[c] ?? 0),
                  r.week_complete ? "complete" : "in progress",
                ],
              }))}
            />
          );
        }}
      </MetricResultView>
      <MetricResultView result={retention} unavailableText={USAGE_TRACKING_PENDING}>
        {(rows) => (
          <>
            <MetricsTable
              label="Retention by sign-up week"
              emptyText="No cohorts."
              columns={[
                { header: "Cohort" },
                { header: "Starts" },
                { header: "Activated", numeric: true },
                { header: "Back in week 1", numeric: true },
                { header: "Back in week 4", numeric: true },
              ]}
              rows={rows.map((r) => ({
                key: r.week_start,
                cells: [
                  r.iso_week,
                  r.week_start,
                  r.activated ?? NOT_AVAILABLE,
                  retentionCell(r.active_week1, r.activated),
                  retentionCell(r.active_week4, r.activated),
                ],
              }))}
            />
            <p className="text-fg-muted text-xs">
              {NOT_AVAILABLE}: the window is still open, started before activity days were recorded,
              or the cohort is too old for the 30-day history.
            </p>
          </>
        )}
      </MetricResultView>
    </MetricsSection>
  );
}
