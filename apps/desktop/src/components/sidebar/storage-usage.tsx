import { useEffect, useMemo, useRef } from "react";
import { View, Text, StyleSheet } from "react-native";
import { formatStorageUsage, storageUsageRatio, storageUsageTone } from "@drafto/shared";
import type { StorageUsageTone } from "@drafto/shared";

import { useStorageUsage } from "@/hooks/use-storage-usage";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontFamily, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

const FILL_COLORS: Record<StorageUsageTone, string> = {
  default: colors.primary[600],
  warning: colors.warning,
  danger: colors.error,
};

/**
 * The sidebar footer's storage line (issue #794): "Storage: 12.4 MB of 50 MB used" and a
 * thin bar, which turns warning above 90% and danger at the quota. No bar when the quota
 * is unlimited; nothing at all until a reading arrives, or when none can be made.
 */
export function StorageUsageMeter() {
  const { usage, refresh } = useStorageUsage();
  const { isSyncing } = useDatabase();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  // Uploads and deletions reach the server during a sync, so re-read once one finishes.
  const wasSyncingRef = useRef(isSyncing);
  useEffect(() => {
    if (wasSyncingRef.current && !isSyncing) void refresh();
    wasSyncingRef.current = isSyncing;
  }, [isSyncing, refresh]);

  if (!usage) return null;

  const label = formatStorageUsage(usage.usedBytes, usage.quotaBytes);
  const ratio = storageUsageRatio(usage);
  const tone = storageUsageTone(usage);
  const filled = ratio === null ? 0 : Math.min(Math.max(ratio, 0), 1);

  return (
    <View testID="storage-usage" style={styles.container}>
      <Text style={[styles.label, tone === "danger" && styles.labelDanger]} numberOfLines={1}>
        {label}
      </Text>
      {ratio !== null ? (
        <View
          testID="storage-usage-bar"
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel={label}
          accessibilityValue={{ min: 0, max: 100, now: Math.round(filled * 100) }}
        >
          <View
            testID="storage-usage-fill"
            style={[styles.fill, { width: `${filled * 100}%`, backgroundColor: FILL_COLORS[tone] }]}
          />
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
      gap: spacing.xs,
    },
    label: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      fontFamily: fontFamily.sans,
    },
    labelDanger: {
      color: semantic.errorText,
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
