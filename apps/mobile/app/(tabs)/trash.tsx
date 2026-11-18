import { useMemo, useCallback } from "react";
import { Text, View, FlatList, Alert, Pressable, RefreshControl, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Q } from "@nozbe/watermelondb";

import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useTrashedNotes } from "@/hooks/use-trashed-notes";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useSwipeHint } from "@/hooks/use-swipe-hint";
import { SwipeableRow } from "@/components/swipeable-row";
import { SwipeHint, SWIPE_HINT_TEXT } from "@/components/swipe-hint";
import { ListSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { colors, fontSizes, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Note, Attachment } from "@/db";
import type { SwipeAction } from "@/components/swipeable-row";

export default function TrashScreen() {
  const { database, sync } = useDatabase();
  const { refreshing, onRefresh } = usePullToRefresh(sync);
  const { notes, loading } = useTrashedNotes();
  const { semantic } = useTheme();
  const swipeHint = useSwipeHint("trash");
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const restoreNote = useCallback(
    async (id: string) => {
      try {
        const note = await database.get<Note>("notes").find(id);
        await database.write(async () => {
          await note.update((record) => {
            record.isTrashed = false;
            record.trashedAt = null;
          });
        });
        sync();
      } catch (err) {
        Alert.alert("Error", err instanceof Error ? err.message : "Failed to restore note");
      }
    },
    [database, sync],
  );

  const handleRestore = useCallback(
    (id: string, title: string) => {
      Alert.alert("Restore Note", `Restore "${title}" from trash?`, [
        { text: "Cancel", style: "cancel" },
        { text: "Restore", onPress: () => restoreNote(id) },
      ]);
    },
    [restoreNote],
  );

  const handleDeletePermanent = useCallback(
    (id: string, title: string) => {
      Alert.alert(
        "Delete Permanently",
        `Are you sure you want to permanently delete "${title}"? This cannot be undone.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                const note = await database.get<Note>("notes").find(id);
                const attachments = await database
                  .get<Attachment>("attachments")
                  .query(Q.where("note_id", id))
                  .fetch();
                await database.write(async () => {
                  for (const attachment of attachments) {
                    await attachment.markAsDeleted();
                  }
                  await note.markAsDeleted();
                });
                sync();
              } catch (err) {
                Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete note");
              }
            },
          },
        ],
      );
    },
    [database, sync],
  );

  // The tap path to both actions, for anyone who doesn't swipe. Restore is
  // undoable, so picking it here is the confirmation; deleting still asks.
  const openNoteMenu = useCallback(
    (id: string, title: string) => {
      Alert.alert(
        title || "Untitled",
        undefined,
        [
          { text: "Restore", onPress: () => restoreNote(id) },
          {
            text: "Delete permanently",
            style: "destructive",
            onPress: () => handleDeletePermanent(id, title),
          },
          { text: "Cancel", style: "cancel" },
        ],
        { cancelable: true },
      );
    },
    [restoreNote, handleDeletePermanent],
  );

  const renderNote = ({ item, index }: { item: Note; index: number }) => {
    const trashedDate = item.trashedAt ? item.trashedAt.toLocaleDateString() : "";

    const leftActions: SwipeAction[] = [
      {
        icon: "arrow-undo-outline",
        label: "Restore note",
        color: colors.white,
        backgroundColor: colors.success,
        onPress: () => handleRestore(item.id, item.title),
      },
    ];

    const rightActions: SwipeAction[] = [
      {
        icon: "trash-outline",
        label: "Delete note permanently",
        color: colors.white,
        backgroundColor: colors.error,
        onPress: () => handleDeletePermanent(item.id, item.title),
      },
    ];

    return (
      <SwipeableRow
        leftActions={leftActions}
        rightActions={rightActions}
        peek={swipeHint.peek && index === 0}
        onPeekEnd={swipeHint.endPeek}
        onOpen={swipeHint.dismiss}
      >
        {(accessibility) => (
          <Pressable
            {...accessibility}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => openNoteMenu(item.id, item.title)}
          >
            <Ionicons
              name="document-text-outline"
              size={20}
              color={semantic.fgSubtle}
              style={styles.rowIcon}
            />
            <View style={styles.rowContent}>
              <Text style={styles.rowText} numberOfLines={1}>
                {item.title}
              </Text>
              {trashedDate ? (
                <Text style={styles.rowDate} numberOfLines={1}>
                  Trashed {trashedDate}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
      </SwipeableRow>
    );
  };

  if (loading) {
    return <ListSkeleton variant="trash" />;
  }

  return (
    <View style={styles.container}>
      {notes.length === 0 ? (
        <EmptyState
          icon="trash-outline"
          title="Trash is empty"
          subtitle="Deleted notes will appear here"
        />
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(item) => item.id}
          renderItem={renderNote}
          ListHeaderComponent={
            swipeHint.visible ? (
              <SwipeHint text={SWIPE_HINT_TEXT.trash} onDismiss={swipeHint.dismiss} />
            ) : null
          }
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary[600]}
              colors={[colors.primary[600]]}
            />
          }
        />
      )}
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: semantic.bgSubtle,
    },
    list: {
      paddingVertical: spacing.sm,
    },
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
    rowContent: {
      flex: 1,
    },
    rowText: {
      fontSize: fontSizes.xl,
      color: semantic.fg,
    },
    rowDate: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      marginTop: 2,
    },
  });
