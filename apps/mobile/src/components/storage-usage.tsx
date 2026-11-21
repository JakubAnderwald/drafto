import { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import {
  formatContentUsage,
  formatStorageUsage,
  storageUsageRatio,
  storageUsageTone,
  type StorageUsage as StorageUsageReading,
  type StorageUsageTone,
} from "@drafto/shared";

import { useContentUsage, useStorageUsage } from "@/hooks/use-storage-usage";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

const FILL_COLORS: Record<StorageUsageTone, string> = {
  default: colors.primary[600],
  warning: colors.warning,
  danger: colors.error,
};

type Styles = ReturnType<typeof createStyles>;

/**
 * "Notes: 1.2 MB of 25 MB used" (ADR 0090), in the storage line's tones. Nothing
 * until a reading arrives, or when none can be made.
 */
function ContentUsageLine({
  usage,
  styles,
}: {
  usage: StorageUsageReading | null;
  styles: Styles;
}) {
  if (!usage) return null;
  const tone = storageUsageTone(usage);
  return (
    <Text
      style={[
        styles.label,
        tone === "warning" && styles.labelWarning,
        tone === "danger" && styles.labelDanger,
      ]}
      testID="content-usage"
    >
      {formatContentUsage(usage.usedBytes, usage.quotaBytes)}
    </Text>
  );
}

/**
 * The signed-in user's attachment storage (issue #794): one line of usage, plus a
 * thin bar of how much of the quota it is (none when unlimited), and the note
 * content line below it (ADR 0090). Re-read after every sync, which is when queued
 * attachments upload and edited notes are pushed.
 */
export function StorageUsage() {
  const { lastSyncedAt } = useDatabase();
  const refreshKey = lastSyncedAt?.getTime() ?? null;
  const { usage, loading } = useStorageUsage(refreshKey);
  const { usage: contentUsage } = useContentUsage(refreshKey);
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  if (!usage) {
    return (
      <View style={styles.container} testID="storage-usage">
        <Text style={styles.quiet}>
          {loading ? "Checking storage…" : "Storage usage is unavailable right now."}
        </Text>
        <ContentUsageLine usage={contentUsage} styles={styles} />
      </View>
    );
  }

  const label = formatStorageUsage(usage.usedBytes, usage.quotaBytes);
  const ratio = storageUsageRatio(usage);
  const tone = storageUsageTone(usage);
  const filled = ratio === null ? null : Math.min(Math.max(ratio, 0), 1);

  return (
    <View style={styles.container} testID="storage-usage">
      <Text
        style={[
          styles.label,
          tone === "warning" && styles.labelWarning,
          tone === "danger" && styles.labelDanger,
        ]}
      >
        {label}
      </Text>
      {filled !== null ? (
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel="Storage used"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(filled * 100) }}
          testID="storage-usage-bar"
        >
          <View
            style={[styles.fill, { width: `${filled * 100}%`, backgroundColor: FILL_COLORS[tone] }]}
            testID="storage-usage-fill"
          />
        </View>
      ) : null}
      <ContentUsageLine usage={contentUsage} styles={styles} />
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      padding: spacing.lg,
      backgroundColor: semantic.bg,
      borderRadius: radii.lg,
      gap: spacing.sm,
    },
    label: {
      fontSize: fontSizes.md,
      color: semantic.fg,
    },
    labelWarning: {
      color: semantic.warningText,
    },
    labelDanger: {
      color: semantic.errorText,
    },
    quiet: {
      fontSize: fontSizes.md,
      color: semantic.fgMuted,
    },
    track: {
      height: spacing.xs,
      borderRadius: radii.full,
      backgroundColor: semantic.bgMuted,
      overflow: "hidden",
    },
    fill: {
      height: "100%",
      borderRadius: radii.full,
    },
  });
