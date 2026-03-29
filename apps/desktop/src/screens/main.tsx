import { useMemo } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";

import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

export function MainScreen() {
  const { user, signOut } = useAuth();
  const { isSyncing, lastSyncedAt, hasPendingChanges } = useDatabase();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Drafto</Text>
      <Text style={styles.subtitle}>macOS Desktop App</Text>
      <Text style={styles.info}>Logged in as {user?.email}</Text>

      <View style={styles.syncStatus}>
        <Text style={styles.syncText}>
          {isSyncing
            ? "Syncing..."
            : lastSyncedAt
              ? `Last synced: ${lastSyncedAt.toLocaleTimeString()}`
              : "Not synced yet"}
        </Text>
        {hasPendingChanges && <Text style={styles.pendingText}>Pending changes</Text>}
      </View>

      <Pressable
        style={({ pressed }) => [styles.signOutButton, pressed && styles.signOutButtonPressed]}
        onPress={signOut}
      >
        <Text style={styles.signOutButtonText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      padding: 24,
      backgroundColor: semantic.bg,
    },
    title: {
      fontSize: 28,
      fontWeight: "700",
      color: semantic.fg,
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 16,
      color: semantic.fgMuted,
      marginBottom: 24,
    },
    info: {
      fontSize: 14,
      color: semantic.fgMuted,
      marginBottom: 16,
    },
    syncStatus: {
      alignItems: "center",
      marginBottom: 24,
    },
    syncText: {
      fontSize: 13,
      color: semantic.fgSubtle,
    },
    pendingText: {
      fontSize: 13,
      color: colors.primary[600],
      marginTop: 4,
    },
    signOutButton: {
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: 8,
      padding: 14,
      paddingHorizontal: 24,
    },
    signOutButtonPressed: {
      backgroundColor: semantic.bgMuted,
    },
    signOutButtonText: {
      color: colors.primary[600],
      fontSize: 16,
      fontWeight: "600",
    },
  });
