import { useMemo } from "react";
import { Text, View, StyleSheet, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { SyncStatus } from "@/components/sync-status";
import { useAuth } from "@/providers/auth-provider";
import { useTheme, type ThemePreference } from "@/providers/theme-provider";
import { useHaptics } from "@/hooks/use-haptics";
import { colors } from "@/theme/tokens";
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
  const { signOut } = useAuth();
  const { semantic, theme, setTheme } = useTheme();
  const haptics = useHaptics();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

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
      <Pressable style={styles.signOutButton} onPress={signOut}>
        <Ionicons name="log-out-outline" size={20} color={colors.error} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </Pressable>
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
      padding: 16,
      gap: 8,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: "600",
      color: semantic.fgSubtle,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: 8,
      marginBottom: 4,
      marginLeft: 4,
    },
    themeRow: {
      flexDirection: "row",
      gap: 8,
    },
    themeOption: {
      flex: 1,
      alignItems: "center",
      gap: 6,
      paddingVertical: 14,
      backgroundColor: semantic.bg,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: "transparent",
    },
    themeOptionActive: {
      borderColor: colors.primary[600],
      backgroundColor: semantic.bgSubtle,
    },
    themeOptionText: {
      fontSize: 13,
      fontWeight: "500",
      color: semantic.fgMuted,
    },
    themeOptionTextActive: {
      color: colors.primary[600],
      fontWeight: "600",
    },
    signOutButton: {
      flexDirection: "row",
      alignItems: "center",
      padding: 16,
      backgroundColor: semantic.bg,
      borderRadius: 12,
      gap: 12,
    },
    signOutText: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.error,
    },
  });
