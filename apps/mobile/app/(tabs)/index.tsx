import { useState, useMemo, useCallback } from "react";
import {
  Text,
  View,
  FlatList,
  Pressable,
  TextInput,
  Alert,
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
import { useHaptics } from "@/hooks/use-haptics";
import { generateId } from "@/lib/generate-id";
import { SwipeableRow } from "@/components/swipeable-row";
import { ListSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Notebook, Note, Attachment } from "@/db";
import type { SwipeAction } from "@/components/swipeable-row";

export default function NotebooksScreen() {
  const { user } = useAuth();
  const { database, sync, isSyncing } = useDatabase();
  const router = useRouter();
  const { notebooks, loading } = useNotebooks();
  const { semantic } = useTheme();
  const haptics = useHaptics();
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
      haptics.success();
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

  const handleDelete = useCallback(
    (id: string, name: string) => {
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
              Alert.alert(
                "Error",
                err instanceof Error ? err.message : "Failed to delete notebook",
              );
            }
          },
        },
      ]);
    },
    [database, sync],
  );

  const startEditing = (notebook: Notebook) => {
    haptics.medium();
    setEditingId(notebook.id);
    setEditName(notebook.name);
  };

  const renderNotebook = ({ item }: { item: Notebook }) => {
    if (editingId === item.id) {
      return (
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.editInput]}
            defaultValue={editName}
            onChangeText={setEditName}
            autoFocus
            autoCorrect={false}
            autoComplete="off"
            onSubmitEditing={() => handleRename(item.id)}
            returnKeyType="done"
          />
          <Pressable
            testID="checkmark"
            onPress={() => handleRename(item.id)}
            style={styles.iconButton}
          >
            <Ionicons name="checkmark" size={22} color={colors.primary[600]} />
          </Pressable>
          <Pressable
            testID="close"
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

    const rightActions: SwipeAction[] = [
      {
        icon: "trash-outline",
        color: colors.white,
        backgroundColor: colors.error,
        onPress: () => handleDelete(item.id, item.name),
      },
    ];

    return (
      <SwipeableRow rightActions={rightActions}>
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
        </Pressable>
      </SwipeableRow>
    );
  };

  if (loading) {
    return <ListSkeleton variant="notebook" />;
  }

  return (
    <View style={styles.container}>
      {creating && (
        <View style={styles.createBar}>
          <TextInput
            testID="notebook-name-input"
            style={[styles.input, styles.createInput]}
            placeholder="Notebook name"
            placeholderTextColor={semantic.fgSubtle}
            value={newName}
            onChangeText={setNewName}
            autoFocus
            autoCorrect={false}
            autoComplete="off"
            onSubmitEditing={handleCreate}
            returnKeyType="done"
          />
          <Pressable testID="checkmark" onPress={handleCreate} style={styles.iconButton}>
            <Ionicons name="checkmark" size={22} color={colors.primary[600]} />
          </Pressable>
          <Pressable
            testID="close"
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
        <EmptyState icon="book-outline" title="No notebooks yet" subtitle="Tap + to create one" />
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
          testID="add"
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          onPress={() => {
            haptics.light();
            setCreating(true);
          }}
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
    rowText: {
      flex: 1,
      fontSize: fontSizes.xl,
      color: semantic.fg,
    },
    iconButton: {
      padding: spacing.sm,
    },
    input: {
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: radii.md,
      padding: spacing.md,
      fontSize: fontSizes.xl,
      backgroundColor: semantic.bg,
      color: semantic.fg,
    },
    createBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      backgroundColor: semantic.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: semantic.border,
    },
    createInput: {
      flex: 1,
      marginRight: spacing.sm,
    },
    editInput: {
      flex: 1,
      marginRight: spacing.sm,
    },
    fab: {
      position: "absolute",
      right: spacing.xl,
      bottom: spacing.xl,
      width: 56,
      height: 56,
      borderRadius: radii.full,
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
  });
