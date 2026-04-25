import { useMemo, useState, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";

import { formatRelativeTime } from "@drafto/shared";

import { useAuth } from "@/providers/auth-provider";
import { useNotes } from "@/hooks/use-notes";
import { database, Note } from "@/db";
import { generateId } from "@/lib/generate-id";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { useTheme } from "@/providers/theme-provider";
import { EmptyState } from "@/components/ui/empty-state";

interface NoteListProps {
  notebookId: string | undefined;
  selectedNoteId: string | undefined;
  onSelectNote: (id: string) => void;
}

export function NoteList({ notebookId, selectedNoteId, onSelectNote }: NoteListProps) {
  const { notes, loading } = useNotes(notebookId);
  const { user } = useAuth();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const handleCreateNote = useCallback(async () => {
    if (!notebookId || !user) return;

    try {
      const noteId = generateId();
      await database.write(async () => {
        await database.get<Note>("notes").create((n) => {
          n._raw.id = noteId;
          n.remoteId = noteId;
          n.userId = user.id;
          n.notebookId = notebookId;
          n.title = "Untitled";
          n.content = null;
          n.isTrashed = false;
        });
      });

      onSelectNote(noteId);
    } catch (err) {
      console.error("Failed to create note:", err);
    }
  }, [notebookId, user, onSelectNote]);

  const handleTrashNote = useCallback(async (note: Note) => {
    try {
      await database.write(async () => {
        await note.update((n) => {
          n.isTrashed = true;
          n.trashedAt = new Date();
        });
      });
    } catch (err) {
      console.error("Failed to trash note:", err);
    }
  }, []);

  if (!notebookId) {
    return (
      <View style={styles.container}>
        <EmptyState
          icon="📓"
          title="Select a notebook"
          subtitle="Choose a notebook from the sidebar to view its notes"
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Notes</Text>
        <Pressable
          style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
          onPress={handleCreateNote}
          accessibilityLabel="New note"
          accessibilityRole="button"
          testID="new-note-button"
        >
          <Text style={styles.addButtonText}>+</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={colors.primary[600]} />
        </View>
      ) : notes.length === 0 ? (
        <EmptyState icon="📝" title="No notes yet" subtitle="Create your first note" />
      ) : (
        <ScrollView style={styles.list}>
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              isSelected={note.id === selectedNoteId}
              onSelect={() => onSelectNote(note.id)}
              onTrash={() => handleTrashNote(note)}
              styles={styles}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

interface NoteRowProps {
  note: Note;
  isSelected: boolean;
  onSelect: () => void;
  onTrash: () => void;
  styles: ReturnType<typeof createStyles>;
}

function NoteRow({ note, isSelected, onSelect, onTrash, styles }: NoteRowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      style={[styles.noteItem, isSelected && styles.noteItemSelected]}
      onPress={onSelect}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityLabel={note.title || "Untitled"}
    >
      <View style={styles.noteItemRow}>
        <Text style={[styles.noteTitle, isSelected && styles.noteTitleSelected]} numberOfLines={1}>
          {note.title || "Untitled"}
        </Text>
        <Pressable
          style={[styles.trashButton, !hovered && styles.trashButtonHidden]}
          onPress={onTrash}
          hitSlop={8}
          accessibilityLabel="Delete note"
          accessibilityRole="button"
        >
          <Text style={styles.trashButtonText}>&times;</Text>
        </Pressable>
      </View>
      <Text style={styles.noteDate}>{formatRelativeTime(note.updatedAt)}</Text>
    </Pressable>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: semantic.bg,
      borderRightWidth: 1,
      borderRightColor: semantic.border,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: spacing.md,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
    },
    headerTitle: {
      fontSize: fontSizes.md,
      fontWeight: "600",
      color: semantic.fgMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    addButton: {
      width: 24,
      height: 24,
      borderRadius: radii.sm,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.primary[600],
    },
    addButtonPressed: {
      backgroundColor: colors.primary[700],
    },
    addButtonText: {
      fontSize: fontSizes.xl,
      fontWeight: "600",
      color: colors.white,
      lineHeight: 18,
    },
    loadingContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    list: {
      flex: 1,
    },
    noteItem: {
      padding: spacing.md,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
    },
    noteItemSelected: {
      backgroundColor: semantic.bgMuted,
    },
    noteItemRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    noteTitle: {
      fontSize: fontSizes.base,
      fontWeight: "500",
      color: semantic.fg,
      flex: 1,
    },
    noteTitleSelected: {
      fontWeight: "600",
    },
    trashButton: {
      marginLeft: spacing.xs,
      opacity: 1,
    },
    trashButtonHidden: {
      opacity: 0,
    },
    trashButtonText: {
      fontSize: fontSizes.xl,
      color: semantic.fgMuted,
    },
    noteDate: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      marginTop: spacing.xs,
    },
  });
