"use client";

import { formatContentUsage } from "@drafto/shared";
import { UsageSection, type UsageSectionConfig } from "@/components/settings/usage-section";
import { fetchContentUsage } from "@/lib/storage/fetch-storage-usage";

const CONTENT_USAGE_CONFIG: UsageSectionConfig = {
  title: "Notes",
  description: "The text of your notes counts toward it, notes in the trash included.",
  loadingText: "Notes: loading…",
  unavailableText: "Notes usage unavailable",
  progressLabel: "Notes space used",
  testIdPrefix: "content-usage",
  fetchUsage: fetchContentUsage,
  formatUsage: formatContentUsage,
};

export interface ContentUsageSectionProps {
  className?: string;
}

/** The settings card that shows how much of the user's note content quota is used (ADR 0090). */
export function ContentUsageSection({ className }: Readonly<ContentUsageSectionProps>) {
  return <UsageSection config={CONTENT_USAGE_CONFIG} className={className} />;
}
