import { Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";

import { useTheme } from "@/providers/theme-provider";

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
    padding: 24,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: 14,
    marginTop: 4,
    textAlign: "center",
  },
});
