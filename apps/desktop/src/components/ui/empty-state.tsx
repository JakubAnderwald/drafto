import { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import type { SemanticColors } from "@/theme/tokens";

interface EmptyStateProps {
  icon: string;
  title: string;
  subtitle?: string;
}

export function EmptyState({ icon, title, subtitle }: EmptyStateProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  return (
    <View style={styles.container}>
      <View style={styles.iconContainer}>
        <Text style={styles.icon}>{icon}</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    iconContainer: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: semantic.bgMuted,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 16,
    },
    icon: {
      fontSize: 24,
    },
    title: {
      fontSize: 16,
      fontWeight: "600",
      color: semantic.fg,
      textAlign: "center",
      marginBottom: 4,
    },
    subtitle: {
      fontSize: 13,
      color: semantic.fgMuted,
      textAlign: "center",
      maxWidth: 240,
    },
  });
