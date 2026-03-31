import { useMemo } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";

import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { colors } from "@/theme/tokens";
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
        ? `${pendingChangesCount} pending`
        : "Synced";

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
      accessibilityHint={statusText}
    >
      <View style={styles.row}>
        {isSyncing ? (
          <ActivityIndicator size="small" color={statusColor} />
        ) : (
          <View style={[styles.dot, { backgroundColor: statusColor }]} />
        )}
        <Text style={styles.statusText}>{statusText}</Text>
      </View>
      <Text style={styles.lastSynced}>{formatLastSynced(lastSyncedAt)}</Text>
    </Pressable>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      padding: 12,
      gap: 2,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    statusText: {
      fontSize: 12,
      fontWeight: "500",
      color: semantic.fgMuted,
    },
    lastSynced: {
      fontSize: 11,
      color: semantic.fgSubtle,
      marginLeft: 14,
    },
  });
