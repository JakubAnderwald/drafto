import { Badge } from "@/components/ui/badge";
import { formatBytes, formatPct, formatUtcTimestamp } from "@/lib/metrics/format";
import type { NeedsAttention } from "@/lib/metrics/needs-attention";
import { MetricsSection } from "@/app/(app)/admin/stats/metrics-section";
import { MetricsTable } from "@/app/(app)/admin/stats/metrics-table";
import { LIMIT_LEVEL_BADGE, resourceLabel } from "@/app/(app)/admin/stats/limit-level";

export interface NeedsAttentionSectionProps {
  needsAttention: NeedsAttention;
  emptiedNotesDays: number;
}

export function NeedsAttentionSection({
  needsAttention,
  emptiedNotesDays,
}: NeedsAttentionSectionProps) {
  const { emptiedNotes, limits, unchecked, isClear } = needsAttention;
  return (
    <MetricsSection
      id="needs-attention"
      title="Needs attention"
      caption={`Is anything broken or running out? Notes one save emptied in the last ${emptiedNotesDays} days, and platform limits from 70%.`}
      tone={isClear ? "default" : "warning"}
    >
      {isClear ? <p className="text-fg text-sm">Nothing needs attention</p> : null}
      {emptiedNotes.length > 0 ? (
        <MetricsTable
          label="Emptied notes"
          columns={[
            { header: "Emptied (UTC)" },
            { header: "Client" },
            { header: "Characters before", numeric: true },
            { header: "Note ID" },
            { header: "User ID" },
          ]}
          rows={emptiedNotes.map((n) => ({
            key: `${n.note_id}-${n.emptied_at}`,
            cells: [
              formatUtcTimestamp(n.emptied_at),
              n.client,
              n.chars_before.toLocaleString("en-US"),
              <code key="note" className="text-xs">
                {n.note_id}
              </code>,
              <code key="user" className="text-xs">
                {n.user_id}
              </code>,
            ],
          }))}
        />
      ) : null}
      {limits.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {limits.map((l) => (
            <li key={l.resource} className="text-fg flex items-center gap-2">
              <Badge variant={LIMIT_LEVEL_BADGE[l.level]}>{l.level}</Badge>
              {resourceLabel(l.resource)}: {formatBytes(l.used_bytes)} of{" "}
              {formatBytes(l.limit_bytes)} ({formatPct(l.pct)})
            </li>
          ))}
        </ul>
      ) : null}
      {unchecked.length > 0 ? (
        <ul className="text-error-text space-y-1 text-sm" role="alert">
          {unchecked.map((u) => (
            <li key={u.check}>
              Couldn&apos;t check {u.check.toLowerCase()}: {u.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </MetricsSection>
  );
}
