import { useMemo, useState } from "react";
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
import { colors, fontSizes, radii, spacing, type SemanticColors } from "@/theme/tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
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
}: ButtonProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [hovered, setHovered] = useState(false);

  const isDisabled = disabled || loading;

  const containerStyle = [
    styles.base,
    styles[`size_${size}`],
    styles[`variant_${variant}`],
    hovered && !isDisabled ? styles[`variant_${variant}_hover`] : null,
    fullWidth ? styles.fullWidth : null,
    isDisabled ? styles.disabled : null,
    style,
  ];

  const textStyle = [styles.textBase, styles[`textSize_${size}`], styles[`textVariant_${variant}`]];

  const spinnerColor =
    variant === "primary" || variant === "danger" ? semantic.onPrimary : semantic.fg;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [containerStyle, pressed && !isDisabled ? styles.pressed : null]}
    >
      {loading ? (
        <ActivityIndicator color={spinnerColor} size="small" />
      ) : (
        <View style={styles.content}>
          {leftIcon ? <View style={styles.leftIcon}>{leftIcon}</View> : null}
          <Text style={textStyle}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    base: {
      borderRadius: radii.md,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "transparent",
    },
    content: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    leftIcon: {
      marginRight: spacing.sm,
    },
    fullWidth: {
      width: "100%",
    },
    disabled: {
      opacity: 0.5,
    },
    pressed: {
      opacity: 0.85,
    },
    // Sizes
    size_sm: {
      paddingVertical: 6,
      paddingHorizontal: spacing.md,
      minHeight: 28,
    },
    size_md: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.lg,
      minHeight: 36,
    },
    size_lg: {
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.xl,
      minHeight: 44,
    },
    // Primary
    variant_primary: {
      backgroundColor: colors.primary[600],
      borderColor: colors.primary[600],
    },
    variant_primary_hover: {
      backgroundColor: colors.primary[700],
      borderColor: colors.primary[700],
    },
    // Secondary
    variant_secondary: {
      backgroundColor: semantic.bg,
      borderColor: semantic.borderStrong,
    },
    variant_secondary_hover: {
      backgroundColor: semantic.bgMuted,
    },
    // Ghost
    variant_ghost: {
      backgroundColor: "transparent",
      borderColor: "transparent",
    },
    variant_ghost_hover: {
      backgroundColor: semantic.bgMuted,
    },
    // Danger
    variant_danger: {
      backgroundColor: colors.error,
      borderColor: colors.error,
    },
    variant_danger_hover: {
      backgroundColor: semantic.errorHover,
      borderColor: semantic.errorHover,
    },
    // Text base
    textBase: {
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
    textVariant_primary: {
      color: semantic.onPrimary,
    },
    textVariant_secondary: {
      color: semantic.fg,
    },
    textVariant_ghost: {
      color: semantic.fg,
    },
    textVariant_danger: {
      color: semantic.onPrimary,
    },
  });
