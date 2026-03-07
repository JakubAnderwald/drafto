import { useState, useMemo, useCallback } from "react";
import {
  Text,
  View,
  FlatList,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNotes } from "@/hooks/use-notes";
import { generateId } from "@/lib/generate-id";
import { SwipeableRow } from "@/components/swipeable-row";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Note } from "@/db";
import type { SwipeAction } from "@/components/swipeable-row";

export default function NotesListScreen() {
  const { id: notebookId } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { database, sync, isSyncing } = useDatabase();
  const router = useRouter();
  const { notes, loading } = useNotes(notebookId);
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    const trimmed = newTitle.trim();
    if (!user || !notebookId || submitting) return;

    try {
      setSubmitting(true);
      const id = generateId();
      await database.write(async () => {
        await database.get<Note>("notes").create((record) => {
          record._raw.id = id;
          record.remoteId = id;
          record.notebookId = notebookId;
          record.userId = user.id;
          record.title = trimmed || "Untitled";
          record.isTrashed = false;
        });
      });
      setNewTitle("");
      setCreating(false);
      sync();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to create note");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRename = async (id: string) => {
    const trimmed = editTitle.trim();
    if (!trimmed || submitting) return;

    try {
      setSubmitting(true);
      const note = await database.get<Note>("notes").find(id);
      await database.write(async () => {
        await note.update((record) => {
          record.title = trimmed;
        });
      });
      setEditingId(null);
      setEditTitle("");
      sync();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to rename note");
    } finally {
      setSubmitting(false);
    }
  };

  const handleTrash = useCallback(
    (id: string, title: string) => {
      Alert.alert("Move to Trash", `Are you sure you want to trash "${title}"?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Trash",
          style: "destructive",
          onPress: async () => {
            try {
              const note = await database.get<Note>("notes").find(id);
              await database.write(async () => {
                await note.update((record) => {
                  record.isTrashed = true;
                  record.trashedAt = new Date();
                });
              });
              sync();
            } catch (err) {
              Alert.alert("Error", err instanceof Error ? err.message : "Failed to trash note");
            }
          },
        },
      ]);
    },
    [database, sync],
  );

  const startEditing = (note: Note) => {
    setEditingId(note.id);
    setEditTitle(note.title);
  };

  const renderNote = ({ item }: { item: Note }) => {
    if (editingId === item.id) {
      return (
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.editInput]}
            value={editTitle}
            onChangeText={setEditTitle}
            autoFocus
            onSubmitEditing={() => handleRename(item.id)}
            returnKeyType="done"
          />
          <Pressable onPress={() => handleRename(item.id)} style={styles.iconButton}>
            <Ionicons name="checkmark" size={22} color={colors.primary[600]} />
          </Pressable>
          <Pressable
            onPress={() => {
              setEditingId(null);
              setEditTitle("");
            }}
            style={styles.iconButton}
          >
            <Ionicons name="close" size={22} color={semantic.fgMuted} />
          </Pressable>
        </View>
      );
    }

    const rightActions: SwipeAction[] = [
      {
        icon: "trash-outline",
        color: colors.white,
        backgroundColor: colors.error,
        onPress: () => handleTrash(item.id, item.title),
      },
    ];

    return (
      <SwipeableRow rightActions={rightActions}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push(`/notes/${item.id}`)}
          onLongPress={() => startEditing(item)}
        >
          <Ionicons
            name="document-text-outline"
            size={20}
            color={colors.primary[600]}
            style={styles.rowIcon}
          />
          <View style={styles.rowContent}>
            <Text style={styles.rowText} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.rowDate} numberOfLines={1}>
              {item.updatedAt.toLocaleDateString()}
            </Text>
          </View>
        </Pressable>
      </SwipeableRow>
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
      {creating && (
        <View style={styles.createBar}>
          <TextInput
            style={[styles.input, styles.createInput]}
            placeholder="Note title (optional)"
            placeholderTextColor={semantic.fgSubtle}
            value={newTitle}
            onChangeText={setNewTitle}
            autoFocus
            onSubmitEditing={handleCreate}
            returnKeyType="done"
          />
          <Pressable onPress={handleCreate} style={styles.iconButton}>
            <Ionicons name="checkmark" size={22} color={colors.primary[600]} />
          </Pressable>
          <Pressable
            onPress={() => {
              setCreating(false);
              setNewTitle("");
            }}
            style={styles.iconButton}
          >
            <Ionicons name="close" size={22} color={semantic.fgMuted} />
          </Pressable>
        </View>
      )}

      {notes.length === 0 && !creating ? (
        <View style={styles.centered}>
          <Ionicons name="document-text-outline" size={48} color={semantic.borderStrong} />
          <Text style={styles.emptyText}>No notes yet</Text>
          <Text style={styles.emptySubtext}>Tap + to create one</Text>
        </View>
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

      {!creating && (
        <Pressable
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          onPress={() => setCreating(true)}
        >
          <Ionicons name="add" size={28} color={semantic.onPrimary} />
        </Pressable>
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
    rowPressed: {
      backgroundColor: semantic.bgMuted,
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
    input: {
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: 8,
      padding: 10,
      fontSize: 16,
      backgroundColor: semantic.bg,
      color: semantic.fg,
    },
    createBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: semantic.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: semantic.border,
    },
    createInput: {
      flex: 1,
      marginRight: 8,
    },
    editInput: {
      flex: 1,
      marginRight: 8,
    },
    fab: {
      position: "absolute",
      right: 20,
      bottom: 20,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.primary[600],
      alignItems: "center",
      justifyContent: "center",
      elevation: 4,
      shadowColor: colors.black,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
    },
    fabPressed: {
      backgroundColor: colors.primary[700],
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
