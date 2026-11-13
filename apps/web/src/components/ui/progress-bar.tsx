import type { StorageUsageTone } from "@drafto/shared";
import { cn } from "@/lib/cn";

export type ProgressBarTone = StorageUsageTone;

export interface ProgressBarProps {
  /** Share complete, from 0 to 1. Values outside that range (or not finite) are clamped. */
  value: number;
  tone?: ProgressBarTone;
  /** Accessible name of the bar (its `aria-label`). */
  label: string;
  className?: string;
}

const toneStyles: Record<ProgressBarTone, string> = {
  default: "bg-primary-500",
  warning: "bg-warning",
  danger: "bg-error",
};

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 1);
}

/** A thin horizontal bar showing how much of something is used or done. */
export function ProgressBar({ value, tone = "default", label, className }: ProgressBarProps) {
  const percent = Math.round(clampRatio(value) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn("bg-bg-muted h-1.5 w-full overflow-hidden rounded-full", className)}
    >
      <div
        data-testid="progress-bar-fill"
        className={cn(
          "h-full rounded-full transition-all duration-[var(--transition-fast)]",
          toneStyles[tone],
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
