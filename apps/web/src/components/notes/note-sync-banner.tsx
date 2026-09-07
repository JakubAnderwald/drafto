"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type NoteSyncBannerTone = "warning" | "error";

export interface NoteSyncBannerProps {
  tone?: NoteSyncBannerTone;
  message: string;
  /** Action controls rendered on the trailing edge. */
  children?: ReactNode;
}

const toneStyles: Record<NoteSyncBannerTone, string> = {
  warning: "bg-warning-bg text-warning-text",
  error: "bg-error-bg text-error-text",
};

/**
 * Non-destructive notice shown above the editor when the open note changed
 * somewhere else. Presentational only — the panel owns every decision about when
 * it appears and what the actions do.
 */
export function NoteSyncBanner({ tone = "warning", message, children }: NoteSyncBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="note-sync-banner"
      className={cn(
        "mx-4 mt-2 flex items-start justify-between gap-3 rounded-lg px-4 py-3 text-sm",
        toneStyles[tone],
      )}
    >
      <span>{message}</span>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
