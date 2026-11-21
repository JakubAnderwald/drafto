import Link from "next/link";
import { requireAdmin } from "@/lib/auth/require-admin";
import { formatUtcTimestamp } from "@/lib/metrics/format";
import { EMPTIED_NOTES_DAYS, loadProductMetrics } from "@/lib/metrics/load-product-metrics";
import { deriveNeedsAttention } from "@/lib/metrics/needs-attention";
import { NeedsAttentionSection } from "@/app/(app)/admin/stats/needs-attention-section";
import { PlatformLimitsSection } from "@/app/(app)/admin/stats/platform-limits-section";
import { ActivationSection } from "@/app/(app)/admin/stats/activation-section";
import { WritersSection } from "@/app/(app)/admin/stats/writers-section";
import { DepthSection } from "@/app/(app)/admin/stats/depth-section";
import { SignupsSection } from "@/app/(app)/admin/stats/signups-section";
import { ActiveUsersSection } from "@/app/(app)/admin/stats/active-users-section";

// Recomputed on every load: the numbers are read live, never cached.
export const dynamic = "force-dynamic";

export default async function AdminStatsPage() {
  await requireAdmin();
  const metrics = await loadProductMetrics();
  const needsAttention = deriveNeedsAttention(metrics);

  return (
    // The app shell is a fixed-height row that clips overflow, so the page scrolls itself.
    <div
      className="mx-auto h-full max-w-4xl space-y-6 overflow-y-auto p-8"
      data-testid="admin-stats"
    >
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-fg text-2xl font-bold">Product metrics</h1>
          <Link
            href="/admin"
            className="text-primary-600 hover:text-primary-700 text-sm font-medium underline-offset-4 hover:underline"
          >
            Back to admin
          </Link>
        </div>
        <p className="text-fg-muted text-sm">
          Generated {formatUtcTimestamp(metrics.generatedAt)} · last {metrics.weeks} ISO weeks ·
          admins and test accounts are excluded.
        </p>
      </header>
      <NeedsAttentionSection
        needsAttention={needsAttention}
        emptiedNotesDays={EMPTIED_NOTES_DAYS}
      />
      <PlatformLimitsSection
        platformLimits={metrics.platformLimits}
        hostedUsage={metrics.hostedUsage}
      />
      <ActivationSection activation={metrics.activation} />
      <WritersSection writers={metrics.writers} />
      <DepthSection depth={metrics.depth} />
      <SignupsSection signups={metrics.signups} />
      <ActiveUsersSection activeUsers={metrics.activeUsers} retention={metrics.retention} />
    </div>
  );
}
