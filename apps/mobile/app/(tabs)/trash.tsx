import { useMemo } from "react";
import {
  Text,
  View,
  FlatList,
  Pressable,
  Alert,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Q } from "@nozbe/watermelondb";

import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useTrashedNotes } from "@/hooks/use-trashed-notes";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Note, Attachment } from "@/db";

export default function TrashScreen() {
  const { database, sync } = useDatabase();
  const { notes, loading } = useTrashedNotes();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const handleRestore = (id: string, title: string) => {
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
  };

  const handleDeletePermanent = (id: string, title: string) => {
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
  };

  const renderNote = ({ item }: { item: Note }) => {
    const trashedDate = item.trashedAt ? item.trashedAt.toLocaleDateString() : "";

    return (
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
        <Pressable
          onPress={() => handleRestore(item.id, item.title)}
          style={styles.iconButton}
          hitSlop={8}
        >
          <Ionicons name="arrow-undo-outline" size={18} color={colors.primary[600]} />
        </Pressable>
        <Pressable
          onPress={() => handleDeletePermanent(item.id, item.title)}
          style={styles.iconButton}
          hitSlop={8}
        >
          <Ionicons name="trash-outline" size={18} color={colors.error} />
        </Pressable>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {notes.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="trash-outline" size={48} color={semantic.borderStrong} />
          <Text style={styles.emptyText}>Trash is empty</Text>
          <Text style={styles.emptySubtext}>Deleted notes will appear here</Text>
        </View>
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(item) => item.id}
          renderItem={renderNote}
          contentContainerStyle={styles.list}
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
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
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
    iconButton: {
      padding: 6,
    },
    emptyText: {
      fontSize: 18,
      color: semantic.fgMuted,
      marginTop: 12,
    },
    emptySubtext: {
      fontSize: 14,
      color: semantic.fgSubtle,
      marginTop: 4,
    },
  });
