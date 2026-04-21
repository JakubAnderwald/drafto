import { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { fontSizes, spacing } from "@/theme/tokens";
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
      padding: spacing["2xl"],
    },
    iconContainer: {
      // Geometric circle: borderRadius is half of width/height
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: semantic.bgMuted,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: spacing.lg,
    },
    icon: {
      // Emoji icon sized as a visual, not typography
      // eslint-disable-next-line no-restricted-syntax -- emoji glyph, not typography
      fontSize: 24,
    },
    title: {
      fontSize: fontSizes.xl,
      fontWeight: "600",
      color: semantic.fg,
      textAlign: "center",
      marginBottom: spacing.xs,
    },
    subtitle: {
      fontSize: fontSizes.md,
      color: semantic.fgMuted,
      textAlign: "center",
      maxWidth: 240,
    },
  });
