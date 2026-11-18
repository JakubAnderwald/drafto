import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Card } from "@/components/ui/card";
import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { SwipeHintList } from "@/lib/swipe-hint-store";

export const SWIPE_HINT_TEXT: Record<SwipeHintList, string> = {
  notes: "Swipe left on a note to move it to Trash. Long-press a note to rename it.",
  notebooks: "Swipe left on a notebook to delete it. Long-press a notebook to rename it.",
  trash:
    "Swipe right on a note to restore it, or left to delete it forever. You can also tap a note.",
};

interface SwipeHintProps {
  text: string;
  onDismiss: () => void;
}

/** A dismissible list-header tip that says the rows below hide actions behind a swipe. */
export function SwipeHint({ text, onDismiss }: SwipeHintProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  return (
    <Card testID="swipe-hint" padding={spacing.md} style={styles.card}>
      <View style={styles.content} accessibilityLiveRegion="polite">
        <Ionicons
          name="swap-horizontal-outline"
          size={20}
          color={semantic.fgMuted}
          style={styles.icon}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Text style={styles.text}>{text}</Text>
        <Pressable
          testID="swipe-hint-dismiss"
          accessibilityRole="button"
          accessibilityLabel="Dismiss hint"
          hitSlop={spacing.sm}
          onPress={onDismiss}
          style={styles.dismiss}
        >
          <Ionicons name="close" size={18} color={semantic.fgMuted} />
        </Pressable>
      </View>
    </Card>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: semantic.bgMuted,
      borderRadius: radii.md,
      marginHorizontal: spacing.lg,
      marginTop: spacing.sm,
      marginBottom: spacing.md,
    },
    content: {
      flexDirection: "row",
      alignItems: "center",
    },
    icon: {
      marginRight: spacing.md,
    },
    text: {
      flex: 1,
      fontSize: fontSizes.base,
      color: semantic.fgMuted,
    },
    dismiss: {
      marginLeft: spacing.sm,
      padding: spacing.xs,
    },
  });
