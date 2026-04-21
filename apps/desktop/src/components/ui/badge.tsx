import { useMemo } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing, type SemanticColors } from "@/theme/tokens";

export type BadgeVariant = "neutral" | "success" | "warning" | "error";

interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Badge({ label, variant = "neutral", style, testID }: BadgeProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  return (
    <View testID={testID} style={[styles.base, styles[`variant_${variant}`], style]}>
      <Text style={[styles.text, styles[`text_${variant}`]]}>{label}</Text>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    base: {
      borderRadius: radii.full,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      alignSelf: "flex-start",
    },
    text: {
      fontSize: fontSizes.xs,
      fontWeight: "600",
    },
    variant_neutral: {
      backgroundColor: semantic.bgMuted,
    },
    variant_success: {
      backgroundColor: semantic.successBg,
    },
    variant_warning: {
      backgroundColor: semantic.warningBg,
    },
    variant_error: {
      backgroundColor: semantic.errorBg,
    },
    text_neutral: {
      color: semantic.fgMuted,
    },
    text_success: {
      color: semantic.successText,
    },
    text_warning: {
      color: semantic.warningText,
    },
    text_error: {
      color: semantic.errorText,
    },
  });
