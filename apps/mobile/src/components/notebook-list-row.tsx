import { useMemo } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { formatNoteCount } from "@drafto/shared";

import { useNotebookNoteCount } from "@/hooks/use-notebook-note-count";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { SwipeRowAccessibilityProps } from "@/components/swipeable-row";

interface NotebookListRowProps {
  notebookId: string;
  name: string;
  /** The swipe row's accessibility actions, spread on the pressable. */
  accessibility: SwipeRowAccessibilityProps;
  onPress: () => void;
  onLongPress: () => void;
}

/**
 * One notebook in the list: its name and, right-aligned, how many notes it holds
 * (PrimeTestLab 11035 S-03). Screen readers hear both, as "Project Ideas, 3 notes".
 */
export function NotebookListRow({
  notebookId,
  name,
  accessibility,
  onPress,
  onLongPress,
}: NotebookListRowProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const count = useNotebookNoteCount(notebookId);

  return (
    <Pressable
      {...accessibility}
      accessibilityRole="button"
      // The name is the label and the count its value, so VoiceOver and TalkBack read
      // "Project Ideas, 3 notes", and the label stays the bare name that tests select by.
      accessibilityLabel={name}
      accessibilityValue={count === null ? undefined : { text: formatNoteCount(count) }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <Ionicons name="book-outline" size={20} color={colors.primary[600]} style={styles.rowIcon} />
      <Text style={styles.rowText} numberOfLines={1}>
        {name}
      </Text>
      {count !== null && (
        <Text testID="notebook-note-count" style={styles.count}>
          {formatNoteCount(count)}
        </Text>
      )}
    </Pressable>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.lg,
      backgroundColor: semantic.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: semantic.border,
    },
    rowPressed: {
      backgroundColor: semantic.bgMuted,
    },
    rowIcon: {
      marginRight: spacing.md,
    },
    rowText: {
      flex: 1,
      fontSize: fontSizes.xl,
      color: semantic.fg,
    },
    count: {
      marginLeft: spacing.md,
      fontSize: fontSizes.md,
      color: semantic.fgMuted,
    },
  });
