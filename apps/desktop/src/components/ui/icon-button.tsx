import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { radii, type SemanticColors } from "@/theme/tokens";

interface IconButtonProps {
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
  size?: number;
  children: ReactNode;
}

/**
 * Ghost-style icon button matching the web app's IconButton: transparent
 * background, hover/pressed surfaces from the muted scale, no border.
 */
export function IconButton({
  onPress,
  accessibilityLabel,
  testID,
  size = 28,
  children,
}: IconButtonProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic, size), [semantic, size]);
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.base,
        hovered && !pressed && styles.hover,
        pressed && styles.pressed,
      ]}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const createStyles = (semantic: SemanticColors, size: number) =>
  StyleSheet.create({
    base: {
      width: size,
      height: size,
      borderRadius: radii.sm,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "transparent",
    },
    hover: {
      backgroundColor: semantic.bgMuted,
    },
    pressed: {
      backgroundColor: semantic.bgMutedHover,
    },
  });
