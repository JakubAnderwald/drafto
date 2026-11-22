import type { BadgeVariant } from "@/components/ui/badge";
import type { ProgressBarTone } from "@/components/ui/progress-bar";
import type { PlatformLimitLevel } from "@/lib/metrics/rpc-schemas";

/** The SQL sets the level (ok below 70%, warn from 70%, critical from 85%); the page only colours it. */
export const LIMIT_LEVEL_TONE: Record<PlatformLimitLevel, ProgressBarTone> = {
  ok: "success",
  warn: "warning",
  critical: "danger",
};

export const LIMIT_LEVEL_BADGE: Record<PlatformLimitLevel, BadgeVariant> = {
  ok: "success",
  warn: "warning",
  critical: "error",
};
