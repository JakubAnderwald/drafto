import { useMemo } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { radii, spacing, type SemanticColors } from "@/theme/tokens";

type PaddingSize = "none" | "sm" | "md" | "lg";

interface CardProps {
  children: React.ReactNode;
  padding?: PaddingSize;
  elevated?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const paddingMap: Record<PaddingSize, number> = {
  none: 0,
  sm: spacing.sm,
  md: spacing.md,
  lg: spacing.lg,
};

export function Card({ children, padding = "lg", elevated = false, style, testID }: CardProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const containerStyle = [
    styles.base,
    { padding: paddingMap[padding] },
    elevated ? styles.elevated : null,
    style,
  ];

  return (
    <View testID={testID} style={containerStyle}>
      {children}
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    base: {
      backgroundColor: semantic.bgSubtle,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: semantic.border,
    },
    elevated: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
    },
  });
