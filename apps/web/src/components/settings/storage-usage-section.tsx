"use client";

import { useEffect, useState } from "react";
import {
  formatStorageUsage,
  storageUsageRatio,
  storageUsageTone,
  type StorageUsage,
} from "@drafto/shared";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress-bar";
import { fetchStorageUsage } from "@/lib/storage/fetch-storage-usage";

const LOADING_TEXT = "Storage: loading…";
const UNAVAILABLE_TEXT = "Storage usage unavailable";

type UsageState =
  { status: "loading" } | { status: "error" } | { status: "ready"; usage: StorageUsage };

export interface StorageUsageSectionProps {
  className?: string;
}

/** The settings card that shows how much of the user's attachment storage is used. */
export function StorageUsageSection({ className }: Readonly<StorageUsageSectionProps>) {
  const [state, setState] = useState<UsageState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void fetchStorageUsage().then((usage) => {
      if (!active) return;
      setState(usage ? { status: "ready", usage } : { status: "error" });
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <Card className={className} data-testid="storage-usage-section">
      <CardHeader>
        <h2 className="text-fg text-lg font-semibold">Storage</h2>
        <p className="text-fg-muted text-sm">Attachments you add to notes count toward it.</p>
      </CardHeader>
      <CardBody>
        {state.status === "ready" ? (
          <StorageUsageDetails usage={state.usage} />
        ) : (
          <p className="text-fg-muted text-sm">
            {state.status === "loading" ? LOADING_TEXT : UNAVAILABLE_TEXT}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function StorageUsageDetails({ usage }: Readonly<{ usage: StorageUsage }>) {
  const ratio = storageUsageRatio(usage);
  const summary = formatStorageUsage(usage.usedBytes, usage.quotaBytes);
  return (
    <>
      <p className="text-fg text-sm" data-testid="storage-usage-text">
        {summary}
      </p>
      {ratio !== null && (
        <ProgressBar
          className="mt-2"
          value={ratio}
          tone={storageUsageTone(usage)}
          label="Storage used"
        />
      )}
    </>
  );
}
