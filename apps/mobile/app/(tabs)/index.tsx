import { useState, useMemo, useCallback } from "react";
import {
  Text,
  View,
  FlatList,
  Pressable,
  TextInput,
  Alert,
  Keyboard,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { Q } from "@nozbe/watermelondb";
import {
  MAX_NOTEBOOK_NAME_LENGTH,
  duplicateNotebookNameMessage,
  findDuplicateNotebook,
} from "@drafto/shared";

import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useHaptics } from "@/hooks/use-haptics";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useSwipeHint } from "@/hooks/use-swipe-hint";
import { generateId } from "@/lib/generate-id";
import { SwipeableRow } from "@/components/swipeable-row";
import { NotebookListRow } from "@/components/notebook-list-row";
import { SwipeHint, SWIPE_HINT_TEXT } from "@/components/swipe-hint";
import { ListSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Fab, useFabLayout } from "@/components/ui/fab";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Notebook, Note, Attachment } from "@/db";
import type { SwipeAction } from "@/components/swipeable-row";

export default function NotebooksScreen() {
  const { user } = useAuth();
  const { database, sync } = useDatabase();
  const { refreshing, onRefresh } = usePullToRefresh(sync);
  const router = useRouter();
  const { notebooks, loading } = useNotebooks();
  const { semantic } = useTheme();
  const haptics = useHaptics();
  const swipeHint = useSwipeHint("notebooks", notebooks[0]?.id);
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // A taken name (PrimeTestLab 11035 M-01): shown under the open field, which stays open.
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  // The FAB hides while the create bar is open; the list then drops back to
  // its resting padding. useFabLayout adds the system-bar inset only off the
  // tab navigator, whose tab bar already takes it.
  const { listPaddingBottom } = useFabLayout(!creating);
  const listContentStyle = useMemo(
    () => [styles.list, { paddingBottom: listPaddingBottom }],
    [styles.list, listPaddingBottom],
  );

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || !user || submitting) return;

    const duplicate = findDuplicateNotebook(trimmed, notebooks);
    if (duplicate) {
      haptics.error();
      setCreateError(duplicateNotebookNameMessage(duplicate.name));
      return;
    }

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
      Keyboard.dismiss();
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

    const duplicate = findDuplicateNotebook(trimmed, notebooks, id);
    if (duplicate) {
      haptics.error();
      setRenameError(duplicateNotebookNameMessage(duplicate.name));
      return;
    }

    try {
      setSubmitting(true);
      const notebook = await database.get<Notebook>("notebooks").find(id);
      await database.write(async () => {
        await notebook.update((record) => {
          record.name = trimmed;
        });
      });
      // The list keeps taps while the keyboard is up, so the keyboard is put away here.
      Keyboard.dismiss();
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
    async (id: string, name: string) => {
      // Fast pre-check: don't even offer deletion while non-trashed notes remain.
      // Mirrors the web API's 409 guard (apps/web/src/app/api/notebooks/[id]/route.ts),
      // which mobile/desktop bypass by writing straight to WatermelonDB + sync.
      let activeNoteCount: number;
      try {
        activeNoteCount = await database
          .get<Note>("notes")
          .query(Q.where("notebook_id", id), Q.where("is_trashed", false))
          .fetchCount();
      } catch (err) {
        Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete notebook");
        return;
      }

      if (activeNoteCount > 0) {
        Alert.alert(
          "Cannot Delete Notebook",
          "Cannot delete notebook with notes. Move or delete notes first.",
        );
        return;
      }

      Alert.alert(
        "Delete Notebook",
        `Delete notebook "${name}"? Trashed notes inside will be permanently deleted.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                const notebook = await database.get<Notebook>("notebooks").find(id);
                // Re-read atomically at delete time: a background sync could have pulled
                // a note into this notebook between the guard check and this confirmation.
                const notes = await database
                  .get<Note>("notes")
                  .query(Q.where("notebook_id", id))
                  .fetch();
                if (notes.some((note) => !note.isTrashed)) {
                  Alert.alert(
                    "Cannot Delete Notebook",
                    "Cannot delete notebook with notes. Move or delete notes first.",
                  );
                  return;
                }
                // Cascade the remaining (all trashed) notes and their attachments locally so
                // the WatermelonDB state matches the server FK `on delete cascade` after sync.
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
        ],
      );
    },
    [database, sync],
  );

  const startEditing = (notebook: Notebook) => {
    haptics.medium();
    setEditingId(notebook.id);
    setEditName(notebook.name);
    setRenameError(null);
  };

  const changeNewName = (text: string) => {
    setNewName(text);
    setCreateError(null);
  };

  const changeEditName = (text: string) => {
    setEditName(text);
    setRenameError(null);
  };

  const renderNameError = (message: string | null) =>
    message ? (
      <Text testID="notebook-name-error" accessibilityRole="alert" style={styles.nameError}>
        {message}
      </Text>
    ) : null;

  const renderNotebook = ({ item }: { item: Notebook }) => {
    if (editingId === item.id) {
      return (
        <View style={styles.editRow}>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, styles.editInput]}
              defaultValue={editName}
              onChangeText={changeEditName}
              autoFocus
              autoCorrect={false}
              autoComplete="off"
              maxLength={MAX_NOTEBOOK_NAME_LENGTH}
              onSubmitEditing={() => handleRename(item.id)}
              submitBehavior="submit"
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
                Keyboard.dismiss();
                setEditingId(null);
                setEditName("");
                setRenameError(null);
              }}
              style={styles.iconButton}
            >
              <Ionicons name="close" size={22} color={semantic.fgMuted} />
            </Pressable>
          </View>
          {renderNameError(renameError)}
        </View>
      );
    }

    const rightActions: SwipeAction[] = [
      {
        icon: "trash-outline",
        label: "Delete notebook",
        color: colors.white,
        backgroundColor: colors.error,
        onPress: () => handleDelete(item.id, item.name),
      },
    ];

    return (
      <SwipeableRow
        rightActions={rightActions}
        peek={item.id === swipeHint.peekRowId}
        onPeekEnd={swipeHint.endPeek}
        onOpen={swipeHint.dismiss}
      >
        {(accessibility) => (
          <NotebookListRow
            notebookId={item.id}
            name={item.name}
            accessibility={accessibility}
            onPress={() => {
              // A rename may still have the keyboard up; it shouldn't follow into the notebook.
              Keyboard.dismiss();
              router.push(`/notebooks/${item.id}`);
            }}
            onLongPress={() => startEditing(item)}
          />
        )}
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
          <View style={styles.inputRow}>
            <TextInput
              testID="notebook-name-input"
              style={[styles.input, styles.createInput]}
              placeholder="Notebook name"
              placeholderTextColor={semantic.fgSubtle}
              value={newName}
              onChangeText={changeNewName}
              autoFocus
              autoCorrect={false}
              autoComplete="off"
              maxLength={MAX_NOTEBOOK_NAME_LENGTH}
              onSubmitEditing={handleCreate}
              submitBehavior="submit"
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
                setCreateError(null);
              }}
              style={styles.iconButton}
            >
              <Ionicons name="close" size={22} color={semantic.fgMuted} />
            </Pressable>
          </View>
          {renderNameError(createError)}
        </View>
      )}

      {notebooks.length === 0 && !creating ? (
        <EmptyState icon="book-outline" title="No notebooks yet" subtitle="Tap + to create one" />
      ) : (
        <FlatList
          data={notebooks}
          keyExtractor={(item) => item.id}
          renderItem={renderNotebook}
          // The rename row's ✓ and ✗ sit inside the list. Without this the first tap
          // on them only closes the keyboard and a second one saves (PrimeTestLab
          // 11035). A tap on empty space still closes the keyboard.
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            swipeHint.visible && notebooks.length > 0 ? (
              <SwipeHint text={SWIPE_HINT_TEXT.notebooks} onDismiss={swipeHint.dismiss} />
            ) : null
          }
          contentContainerStyle={listContentStyle}
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

      {!creating && (
        <Fab
          testID="add"
          accessibilityLabel="New notebook"
          onPress={() => {
            haptics.light();
            setCreateError(null);
            setCreating(true);
          }}
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
    editRow: {
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.lg,
      backgroundColor: semantic.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: semantic.border,
    },
    inputRow: {
      flexDirection: "row",
      alignItems: "center",
    },
    nameError: {
      marginTop: spacing.xs,
      fontSize: fontSizes.sm,
      color: semantic.errorText,
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
  });
