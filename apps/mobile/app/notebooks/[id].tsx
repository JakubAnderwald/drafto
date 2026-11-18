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
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNotes } from "@/hooks/use-notes";
import { useNotebookName } from "@/hooks/use-notebook-name";
import { useHaptics } from "@/hooks/use-haptics";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useSwipeHint } from "@/hooks/use-swipe-hint";
import { generateId } from "@/lib/generate-id";
import { SwipeableRow } from "@/components/swipeable-row";
import { SwipeHint, SWIPE_HINT_TEXT } from "@/components/swipe-hint";
import { ListSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Fab, useFabLayout } from "@/components/ui/fab";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Note } from "@/db";
import type { SwipeAction } from "@/components/swipeable-row";

export default function NotesListScreen() {
  const { id: notebookId } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { database, sync } = useDatabase();
  const { refreshing, onRefresh } = usePullToRefresh(sync);
  const router = useRouter();
  const { notes, loading } = useNotes(notebookId);
  const notebookName = useNotebookName(notebookId);
  const { semantic } = useTheme();
  const haptics = useHaptics();
  const swipeHint = useSwipeHint("notes");
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // The FAB hides while the create bar is open; the list then drops back to
  // its resting padding. useFabLayout adds the system-bar inset only off the
  // tab navigator, whose tab bar already takes it.
  const { listPaddingBottom } = useFabLayout(!creating);
  const listContentStyle = useMemo(
    () => [styles.list, { paddingBottom: listPaddingBottom }],
    [styles.list, listPaddingBottom],
  );

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
      haptics.success();
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
    haptics.medium();
    setEditingId(note.id);
    setEditTitle(note.title);
  };

  const renderNote = ({ item, index }: { item: Note; index: number }) => {
    if (editingId === item.id) {
      return (
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.editInput]}
            defaultValue={editTitle}
            onChangeText={setEditTitle}
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
        label: "Move note to Trash",
        color: colors.white,
        backgroundColor: colors.error,
        onPress: () => handleTrash(item.id, item.title),
      },
    ];

    return (
      <SwipeableRow
        rightActions={rightActions}
        peek={swipeHint.peek && index === 0}
        onPeekEnd={swipeHint.endPeek}
        onOpen={swipeHint.dismiss}
      >
        {(accessibility) => (
          <Pressable
            {...accessibility}
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
        )}
      </SwipeableRow>
    );
  };

  // Rendered in every branch, so the title is set while the list is still loading.
  // Memoised so list re-renders (every sync) don't re-apply unchanged options.
  const headerOptions = useMemo(() => ({ title: notebookName ?? "" }), [notebookName]);
  const header = <Stack.Screen options={headerOptions} />;

  if (loading) {
    return (
      <>
        {header}
        <ListSkeleton variant="note" />
      </>
    );
  }

  return (
    <View style={styles.container} testID="notes-list-screen">
      {header}
      {creating && (
        <View style={styles.createBar}>
          <TextInput
            style={[styles.input, styles.createInput]}
            placeholder="Note title (optional)"
            placeholderTextColor={semantic.fgSubtle}
            value={newTitle}
            onChangeText={setNewTitle}
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
              setNewTitle("");
            }}
            style={styles.iconButton}
          >
            <Ionicons name="close" size={22} color={semantic.fgMuted} />
          </Pressable>
        </View>
      )}

      {notes.length === 0 && !creating ? (
        <EmptyState
          icon="document-text-outline"
          title="No notes yet"
          subtitle="Tap + to create one"
        />
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(item) => item.id}
          renderItem={renderNote}
          ListHeaderComponent={
            swipeHint.visible && notes.length > 0 ? (
              <SwipeHint text={SWIPE_HINT_TEXT.notes} onDismiss={swipeHint.dismiss} />
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
          accessibilityLabel="New note"
          onPress={() => {
            haptics.light();
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
  });
