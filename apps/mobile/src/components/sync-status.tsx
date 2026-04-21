import { useMemo } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

function formatLastSynced(date: Date | null): string {
  if (!date) return "Never";

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 10) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  return date.toLocaleDateString();
}

export function SyncStatus() {
  const { sync, isSyncing, lastSyncedAt, pendingChangesCount, hasPendingChanges } = useDatabase();
  const { isConnected } = useNetworkStatus();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const statusIcon = isSyncing
    ? null
    : !isConnected
      ? "cloud-offline-outline"
      : hasPendingChanges
        ? "cloud-upload-outline"
        : "cloud-done-outline";

  const statusColor = !isConnected
    ? colors.error
    : hasPendingChanges
      ? colors.warning
      : colors.success;

  const statusText = isSyncing
    ? "Syncing..."
    : !isConnected
      ? "Offline"
      : hasPendingChanges
        ? `${pendingChangesCount} pending ${pendingChangesCount === 1 ? "change" : "changes"}`
        : "All synced";

  return (
    <Pressable
      style={styles.container}
      onPress={() => {
        if (isConnected && !isSyncing) {
          sync();
        }
      }}
      accessibilityRole="button"
      accessibilityLabel="Sync status"
      accessibilityHint={isConnected && !isSyncing ? "Double tap to sync now" : undefined}
    >
      <View style={[styles.indicator, { backgroundColor: statusColor }]}>
        {isSyncing ? (
          <ActivityIndicator size="small" color={semantic.onPrimary} />
        ) : (
          statusIcon && (
            <Ionicons
              name={statusIcon as keyof typeof Ionicons.glyphMap}
              size={20}
              color={semantic.onPrimary}
            />
          )
        )}
      </View>
      <View style={styles.details}>
        <Text style={styles.statusText}>{statusText}</Text>
        <Text style={styles.lastSynced}>Last synced: {formatLastSynced(lastSyncedAt)}</Text>
      </View>
      {isConnected && !isSyncing && (
        <Ionicons name="refresh-outline" size={18} color={semantic.fgSubtle} />
      )}
    </Pressable>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      padding: spacing.lg,
      backgroundColor: semantic.bg,
      borderRadius: radii.lg,
      gap: spacing.md,
    },
    indicator: {
      width: 40,
      height: 40,
      borderRadius: radii.full,
      alignItems: "center",
      justifyContent: "center",
    },
    details: {
      flex: 1,
      gap: 2,
    },
    statusText: {
      fontSize: fontSizes.lg,
      fontWeight: "600",
      color: semantic.fg,
    },
    lastSynced: {
      fontSize: fontSizes.md,
      color: semantic.fgMuted,
    },
  });
