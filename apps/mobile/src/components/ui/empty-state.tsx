import { Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";

import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing } from "@/theme/tokens";

interface EmptyStateProps {
  icon: ComponentProps<typeof Ionicons>["name"];
  title: string;
  subtitle: string;
}

export function EmptyState({ icon, title, subtitle }: EmptyStateProps) {
  const { semantic } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: semantic.bgSubtle }]}>
      <View style={[styles.iconCircle, { backgroundColor: semantic.bgMuted }]}>
        <Ionicons name={icon} size={32} color={semantic.fgSubtle} />
      </View>
      <Text style={[styles.title, { color: semantic.fgMuted }]}>{title}</Text>
      <Text style={[styles.subtitle, { color: semantic.fgSubtle }]}>{subtitle}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing["2xl"],
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: fontSizes["2xl"],
    fontWeight: "600",
  },
  subtitle: {
    fontSize: fontSizes.base,
    marginTop: spacing.xs,
    textAlign: "center",
  },
});
