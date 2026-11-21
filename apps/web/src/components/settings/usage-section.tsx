"use client";

import { useEffect, useState } from "react";
import { storageUsageRatio, storageUsageTone, type StorageUsage } from "@drafto/shared";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress-bar";

type UsageState =
  { status: "loading" } | { status: "error" } | { status: "ready"; usage: StorageUsage };

/** What one quota's settings card shows; the storage and notes cards differ only in these. */
export interface UsageSectionConfig {
  title: string;
  description: string;
  loadingText: string;
  unavailableText: string;
  /** The progress bar's accessible name. */
  progressLabel: string;
  /** Prefix of the card's test ids: `<prefix>-section`, `<prefix>-text`. */
  testIdPrefix: string;
  fetchUsage: () => Promise<StorageUsage | null>;
  formatUsage: (usedBytes: number, quotaBytes: number | null) => string;
}

export interface UsageSectionProps {
  config: UsageSectionConfig;
  className?: string;
}

/** A settings card that loads one of the user's usage readings and shows it against its quota. */
export function UsageSection({ config, className }: Readonly<UsageSectionProps>) {
  const [state, setState] = useState<UsageState>({ status: "loading" });
  const { fetchUsage } = config;

  useEffect(() => {
    let active = true;
    void fetchUsage().then((usage) => {
      if (!active) return;
      setState(usage ? { status: "ready", usage } : { status: "error" });
    });
    return () => {
      active = false;
    };
  }, [fetchUsage]);

  return (
    <Card className={className} data-testid={`${config.testIdPrefix}-section`}>
      <CardHeader>
        <h2 className="text-fg text-lg font-semibold">{config.title}</h2>
        <p className="text-fg-muted text-sm">{config.description}</p>
      </CardHeader>
      <CardBody>
        {state.status === "ready" ? (
          <UsageDetails config={config} usage={state.usage} />
        ) : (
          <p className="text-fg-muted text-sm">
            {state.status === "loading" ? config.loadingText : config.unavailableText}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function UsageDetails({
  config,
  usage,
}: Readonly<{ config: UsageSectionConfig; usage: StorageUsage }>) {
  const ratio = storageUsageRatio(usage);
  return (
    <>
      <p className="text-fg text-sm" data-testid={`${config.testIdPrefix}-text`}>
        {config.formatUsage(usage.usedBytes, usage.quotaBytes)}
      </p>
      {ratio !== null && (
        <ProgressBar
          className="mt-2"
          value={ratio}
          tone={storageUsageTone(usage)}
          label={config.progressLabel}
        />
      )}
    </>
  );
}
