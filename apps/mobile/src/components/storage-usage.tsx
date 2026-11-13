import { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import {
  formatStorageUsage,
  storageUsageRatio,
  storageUsageTone,
  type StorageUsageTone,
} from "@drafto/shared";

import { useStorageUsage } from "@/hooks/use-storage-usage";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

const FILL_COLORS: Record<StorageUsageTone, string> = {
  default: colors.primary[600],
  warning: colors.warning,
  danger: colors.error,
};

/**
 * The signed-in user's attachment storage (issue #794): one line of usage, plus a
 * thin bar of how much of the quota it is (none when unlimited). Re-read after
 * every sync, which is when queued attachments upload.
 */
export function StorageUsage() {
  const { lastSyncedAt } = useDatabase();
  const { usage, loading } = useStorageUsage(lastSyncedAt?.getTime() ?? null);
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  if (!usage) {
    return (
      <View style={styles.container} testID="storage-usage">
        <Text style={styles.quiet}>
          {loading ? "Checking storage…" : "Storage usage is unavailable right now."}
        </Text>
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
