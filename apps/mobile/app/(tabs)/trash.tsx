import { useMemo, useCallback } from "react";
import { Text, View, FlatList, Alert, RefreshControl, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Q } from "@nozbe/watermelondb";

import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useTrashedNotes } from "@/hooks/use-trashed-notes";
import { SwipeableRow } from "@/components/swipeable-row";
import { ListSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Note, Attachment } from "@/db";
import type { SwipeAction } from "@/components/swipeable-row";

export default function TrashScreen() {
  const { database, sync, isSyncing } = useDatabase();
  const { notes, loading } = useTrashedNotes();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const handleRestore = useCallback(
    (id: string, title: string) => {
      Alert.alert("Restore Note", `Restore "${title}" from trash?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: async () => {
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
        },
      ]);
    },
    [database, sync],
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

  const renderNote = ({ item }: { item: Note }) => {
    const trashedDate = item.trashedAt ? item.trashedAt.toLocaleDateString() : "";

    const leftActions: SwipeAction[] = [
      {
        icon: "arrow-undo-outline",
        color: colors.white,
        backgroundColor: colors.success,
        onPress: () => handleRestore(item.id, item.title),
      },
    ];

    const rightActions: SwipeAction[] = [
      {
        icon: "trash-outline",
        color: colors.white,
        backgroundColor: colors.error,
        onPress: () => handleDeletePermanent(item.id, item.title),
      },
    ];

    return (
      <SwipeableRow leftActions={leftActions} rightActions={rightActions}>
        <View style={styles.row}>
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
        </View>
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
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={isSyncing}
              onRefresh={sync}
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
      paddingVertical: 8,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 14,
      paddingHorizontal: 16,
      backgroundColor: semantic.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: semantic.border,
    },
    rowIcon: {
      marginRight: 12,
    },
    rowContent: {
      flex: 1,
    },
    rowText: {
      fontSize: 16,
      color: semantic.fg,
    },
    rowDate: {
      fontSize: 12,
      color: semantic.fgSubtle,
      marginTop: 2,
    },
  });
