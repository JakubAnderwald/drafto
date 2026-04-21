import { useMemo, type ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { colors, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

export interface CardProps {
  children: ReactNode;
  padding?: number;
  elevated?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Card({
  children,
  padding = spacing.lg,
  elevated = false,
  style,
  testID,
}: CardProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  return (
    <View testID={testID} style={[styles.card, { padding }, elevated && styles.elevated, style]}>
      {children}
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: semantic.bgSubtle,
      borderRadius: radii.lg,
    },
    elevated: Platform.select({
      ios: {
        shadowColor: colors.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 6,
      },
      android: {
        elevation: 2,
      },
      default: {},
    }),
  });
