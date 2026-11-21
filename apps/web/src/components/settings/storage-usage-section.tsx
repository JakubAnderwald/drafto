"use client";

import { formatStorageUsage } from "@drafto/shared";
import { UsageSection, type UsageSectionConfig } from "@/components/settings/usage-section";
import { fetchStorageUsage } from "@/lib/storage/fetch-storage-usage";

const STORAGE_USAGE_CONFIG: UsageSectionConfig = {
  title: "Storage",
  description: "Attachments you add to notes count toward it.",
  loadingText: "Storage: loading…",
  unavailableText: "Storage usage unavailable",
  progressLabel: "Storage used",
  testIdPrefix: "storage-usage",
  fetchUsage: fetchStorageUsage,
  formatUsage: formatStorageUsage,
};

export interface StorageUsageSectionProps {
  className?: string;
}

/** The settings card that shows how much of the user's attachment storage is used. */
export function StorageUsageSection({ className }: Readonly<StorageUsageSectionProps>) {
  return <UsageSection config={STORAGE_USAGE_CONFIG} className={className} />;
}
