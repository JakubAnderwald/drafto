import { useMemo, useState } from "react";
import { Text, View, StyleSheet, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { DeleteAccountDialog } from "@/components/delete-account-dialog";
import { SyncStatus } from "@/components/sync-status";
import { useAuth } from "@/providers/auth-provider";
import { useTheme, type ThemePreference } from "@/providers/theme-provider";
import { useHaptics } from "@/hooks/use-haptics";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { Button } from "@/components/ui/button";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { value: "system", label: "System", icon: "phone-portrait-outline" },
  { value: "light", label: "Light", icon: "sunny-outline" },
  { value: "dark", label: "Dark", icon: "moon-outline" },
];

export default function SettingsScreen() {
  const { signOut, deleteAccount } = useAuth();
  const { semantic, theme, setTheme } = useTheme();
  const haptics = useHaptics();
  const { isConnected, isInternetReachable } = useNetworkStatus();
  const [isDeleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  // Deletion runs on the server, so it is unavailable offline. Unknown reachability (`null`)
  // stays enabled; only an explicit `false` counts as offline.
  const canDeleteAccount = isConnected && isInternetReachable !== false;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.sectionTitle}>Appearance</Text>
      <View style={styles.themeRow}>
        {THEME_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            style={[styles.themeOption, theme === option.value && styles.themeOptionActive]}
            onPress={() => {
              haptics.selection();
              setTheme(option.value);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: theme === option.value }}
            accessibilityLabel={`${option.label} theme`}
          >
            <Ionicons
              name={option.icon}
              size={20}
              color={theme === option.value ? colors.primary[600] : semantic.fgMuted}
            />
            <Text
              style={[
                styles.themeOptionText,
                theme === option.value && styles.themeOptionTextActive,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Sync</Text>
      <SyncStatus />

      <Text style={styles.sectionTitle}>Account</Text>
      <Button
        title="Sign Out"
        onPress={signOut}
        variant="danger"
        size="lg"
        fullWidth
        leftIcon={<Ionicons name="log-out-outline" size={20} color={colors.white} />}
        accessibilityLabel="Sign out"
      />

      <Pressable
        style={({ pressed }) => [
          styles.deleteRow,
          pressed && canDeleteAccount && styles.deleteRowPressed,
          !canDeleteAccount && styles.deleteRowDisabled,
        ]}
        onPress={() => {
          haptics.warning();
          setDeleteDialogVisible(true);
        }}
        disabled={!canDeleteAccount}
        accessibilityRole="button"
        accessibilityLabel="Delete account"
        accessibilityState={{ disabled: !canDeleteAccount }}
        testID="delete-account-row"
      >
        <Ionicons name="trash-outline" size={20} color={semantic.errorText} />
        <Text style={styles.deleteRowText}>Delete account</Text>
      </Pressable>
      {!canDeleteAccount ? (
        <Text style={styles.offlineNote}>Deleting your account needs an internet connection.</Text>
      ) : null}

      <DeleteAccountDialog
        visible={isDeleteDialogVisible}
        onCancel={() => setDeleteDialogVisible(false)}
        onConfirm={deleteAccount}
      />
    </ScrollView>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    scroll: {
      flex: 1,
      backgroundColor: semantic.bgMuted,
    },
    container: {
      padding: spacing.lg,
      gap: spacing.sm,
    },
    sectionTitle: {
      fontSize: fontSizes.md,
      fontWeight: "600",
      color: semantic.fgSubtle,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: spacing.sm,
      marginBottom: spacing.xs,
      marginLeft: spacing.xs,
    },
    themeRow: {
      flexDirection: "row",
      gap: spacing.sm,
    },
    themeOption: {
      flex: 1,
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.lg,
      backgroundColor: semantic.bg,
      borderRadius: radii.lg,
      borderWidth: 2,
      borderColor: "transparent",
    },
    themeOptionActive: {
      borderColor: colors.primary[600],
      backgroundColor: semantic.bgSubtle,
    },
    themeOptionText: {
      fontSize: fontSizes.md,
      fontWeight: "500",
      color: semantic.fgMuted,
    },
    themeOptionTextActive: {
      color: colors.primary[600],
      fontWeight: "600",
    },
    deleteRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      minHeight: 48,
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.xl,
      backgroundColor: semantic.bg,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: semantic.errorBorder,
    },
    deleteRowPressed: {
      backgroundColor: semantic.errorBg,
    },
    deleteRowDisabled: {
      opacity: 0.5,
    },
    deleteRowText: {
      fontSize: fontSizes.lg,
      fontWeight: "600",
      color: semantic.errorText,
    },
    offlineNote: {
      fontSize: fontSizes.md,
      color: semantic.fgMuted,
      marginLeft: spacing.xs,
    },
  });
