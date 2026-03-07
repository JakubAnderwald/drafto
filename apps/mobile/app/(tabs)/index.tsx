import { useState, useMemo } from "react";
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
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { Q } from "@nozbe/watermelondb";

import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNotebooks } from "@/hooks/use-notebooks";
import { generateId } from "@/lib/generate-id";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Notebook, Note, Attachment } from "@/db";

export default function NotebooksScreen() {
  const { user } = useAuth();
  const { database, sync, isSyncing } = useDatabase();
  const router = useRouter();
  const { notebooks, loading } = useNotebooks();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || !user || submitting) return;

    try {
      setSubmitting(true);
      const id = generateId();
      await database.write(async () => {
        await database.get<Notebook>("notebooks").create((record) => {
          record._raw.id = id;
          record.remoteId = id;
          record.userId = user.id;
          record.name = trimmed;
        });
      });
      setNewName("");
      setCreating(false);
      sync();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to create notebook");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRename = async (id: string) => {
    const trimmed = editName.trim();
    if (!trimmed || submitting) return;

    try {
      setSubmitting(true);
      const notebook = await database.get<Notebook>("notebooks").find(id);
      await database.write(async () => {
        await notebook.update((record) => {
          record.name = trimmed;
        });
      });
      setEditingId(null);
      setEditName("");
      sync();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to rename notebook");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (id: string, name: string) => {
    Alert.alert("Delete Notebook", `Are you sure you want to delete "${name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            const notebook = await database.get<Notebook>("notebooks").find(id);
            const notes = await database
              .get<Note>("notes")
              .query(Q.where("notebook_id", id))
              .fetch();
            await database.write(async () => {
              for (const note of notes) {
                const attachments = await database
                  .get<Attachment>("attachments")
                  .query(Q.where("note_id", note.id))
                  .fetch();
                for (const attachment of attachments) {
                  await attachment.markAsDeleted();
                }
                await note.markAsDeleted();
              }
              await notebook.markAsDeleted();
            });
            sync();
          } catch (err) {
            Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete notebook");
          }
        },
      },
    ]);
  };

  const startEditing = (notebook: Notebook) => {
    setEditingId(notebook.id);
    setEditName(notebook.name);
  };

  const renderNotebook = ({ item }: { item: Notebook }) => {
    if (editingId === item.id) {
      return (
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.editInput]}
            value={editName}
            onChangeText={setEditName}
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
              setEditName("");
            }}
            style={styles.iconButton}
          >
            <Ionicons name="close" size={22} color={semantic.fgMuted} />
          </Pressable>
        </View>
      );
    }

    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => router.push(`/notebooks/${item.id}`)}
        onLongPress={() => startEditing(item)}
      >
        <Ionicons
          name="book-outline"
          size={20}
          color={colors.primary[600]}
          style={styles.rowIcon}
        />
        <Text style={styles.rowText} numberOfLines={1}>
          {item.name}
        </Text>
        <Pressable
          onPress={() => handleDelete(item.id, item.name)}
          style={styles.iconButton}
          hitSlop={8}
        >
          <Ionicons name="trash-outline" size={18} color={semantic.fgSubtle} />
        </Pressable>
      </Pressable>
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
            placeholder="Notebook name"
            placeholderTextColor={semantic.fgSubtle}
            value={newName}
            onChangeText={setNewName}
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
              setNewName("");
            }}
            style={styles.iconButton}
          >
            <Ionicons name="close" size={22} color={semantic.fgMuted} />
          </Pressable>
        </View>
      )}

      {notebooks.length === 0 && !creating ? (
        <View style={styles.centered}>
          <Ionicons name="book-outline" size={48} color={semantic.borderStrong} />
          <Text style={styles.emptyText}>No notebooks yet</Text>
          <Text style={styles.emptySubtext}>Tap + to create one</Text>
        </View>
      ) : (
        <FlatList
          data={notebooks}
          keyExtractor={(item) => item.id}
          renderItem={renderNotebook}
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
    rowText: {
      flex: 1,
      fontSize: 16,
      color: semantic.fg,
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
