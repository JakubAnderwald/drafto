import { useMemo } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

export type BadgeVariant = "neutral" | "success" | "warning" | "error";
export type BadgeSize = "sm" | "md";

export interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  size?: BadgeSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface BadgeColors {
  bg: string;
  text: string;
}

function getBadgeColors(variant: BadgeVariant, semantic: SemanticColors): BadgeColors {
  switch (variant) {
    case "success":
      return { bg: semantic.successBg, text: semantic.successText };
    case "warning":
      return { bg: semantic.warningBg, text: semantic.warningText };
    case "error":
      return { bg: semantic.errorBg, text: semantic.errorText };
    case "neutral":
    default:
      return { bg: semantic.bgMuted, text: semantic.fgMuted };
  }
}

export function Badge({ label, variant = "neutral", size = "sm", style, testID }: BadgeProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const variantColors = useMemo(() => getBadgeColors(variant, semantic), [variant, semantic]);

  return (
    <View
      testID={testID}
      style={[styles.badge, styles[`size_${size}`], { backgroundColor: variantColors.bg }, style]}
    >
      <Text
        style={[styles.text, styles[`textSize_${size}`], { color: variantColors.text }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const createStyles = (_semantic: SemanticColors) =>
  StyleSheet.create({
    badge: {
      alignSelf: "flex-start",
      borderRadius: radii.full,
      flexDirection: "row",
      alignItems: "center",
    },
    size_sm: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    size_md: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    text: {
      fontWeight: "600",
    },
    textSize_sm: {
      fontSize: fontSizes.xs,
    },
    textSize_md: {
      fontSize: fontSizes.sm,
    },
  });
