import { useMemo, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  leftIcon?: ReactNode;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

interface VariantColors {
  bg: string;
  bgPressed: string;
  text: string;
  border?: string;
}

function getVariantColors(variant: ButtonVariant, semantic: SemanticColors): VariantColors {
  switch (variant) {
    case "primary":
      return {
        bg: colors.primary[600],
        bgPressed: colors.primary[700],
        text: semantic.onPrimary,
      };
    case "secondary":
      return {
        bg: "transparent",
        bgPressed: semantic.bgMuted,
        text: semantic.fg,
        border: semantic.borderStrong,
      };
    case "ghost":
      return {
        bg: "transparent",
        bgPressed: semantic.bgMuted,
        text: semantic.fg,
      };
    case "danger":
      return {
        bg: colors.error,
        bgPressed: "#9A1414",
        text: colors.white,
      };
  }
}

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  leftIcon,
  fullWidth = false,
  style,
  testID,
  accessibilityLabel,
}: ButtonProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const variantColors = useMemo(() => getVariantColors(variant, semantic), [variant, semantic]);
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={accessibilityLabel ?? title}
      testID={testID}
      android_ripple={{ color: semantic.bgMuted }}
      style={({ pressed }) => [
        styles.base,
        styles[`size_${size}`],
        {
          backgroundColor: pressed && !isDisabled ? variantColors.bgPressed : variantColors.bg,
        },
        variantColors.border ? { borderWidth: 1, borderColor: variantColors.border } : null,
        fullWidth && styles.fullWidth,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={variantColors.text} />
      ) : (
        <View style={styles.content}>
          {leftIcon ? <View style={styles.leftIcon}>{leftIcon}</View> : null}
          <Text style={[styles.text, styles[`textSize_${size}`], { color: variantColors.text }]}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const createStyles = (_semantic: SemanticColors) =>
  StyleSheet.create({
    base: {
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.md,
    },
    content: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    leftIcon: {
      marginRight: spacing.sm,
    },
    size_sm: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      minHeight: 32,
    },
    size_md: {
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      minHeight: 40,
    },
    size_lg: {
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.xl,
      minHeight: 48,
    },
    text: {
      fontWeight: "600",
    },
    textSize_sm: {
      fontSize: fontSizes.sm,
    },
    textSize_md: {
      fontSize: fontSizes.base,
    },
    textSize_lg: {
      fontSize: fontSizes.lg,
    },
    fullWidth: {
      alignSelf: "stretch",
    },
    disabled: {
      opacity: 0.5,
    },
  });
