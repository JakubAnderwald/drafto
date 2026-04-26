import { useMemo, useState, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";

import { formatRelativeTime } from "@drafto/shared";

import { useAuth } from "@/providers/auth-provider";
import { useNotes } from "@/hooks/use-notes";
import { database, Note } from "@/db";
import { generateId } from "@/lib/generate-id";
import { colors, fontFamily, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { useTheme } from "@/providers/theme-provider";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { PlusIcon } from "@/components/ui/icons/plus-icon";

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
        <Text style={styles.headerTitle}>NOTES</Text>
        <IconButton
          onPress={handleCreateNote}
          accessibilityLabel="New note"
          testID="new-note-button"
        >
          <PlusIcon size={16} color={semantic.fgMuted} />
        </IconButton>
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={colors.primary[600]} />
        </View>
      ) : notes.length === 0 ? (
        <EmptyState icon="📝" title="No notes yet" subtitle="Create your first note" />
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
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
      style={[
        styles.noteItem,
        hovered && !isSelected && styles.noteItemHover,
        isSelected && styles.noteItemSelected,
      ]}
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
          disabled={!hovered}
          focusable={hovered}
          accessibilityElementsHidden={!hovered}
          importantForAccessibility={hovered ? "yes" : "no-hide-descendants"}
          accessibilityLabel="Delete note"
          accessibilityRole="button"
        >
          <Text style={styles.trashButtonText}>&times;</Text>
        </Pressable>
      </View>
      <Text style={[styles.noteDate, isSelected && styles.noteDateSelected]} numberOfLines={1}>
        {formatRelativeTime(note.updatedAt)}
      </Text>
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
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
    },
    headerTitle: {
      fontSize: fontSizes.xs,
      fontWeight: "600",
      color: semantic.fgMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      fontFamily: fontFamily.sans,
    },
    loadingContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.sm,
      gap: 2,
    },
    noteItem: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radii.sm,
      borderLeftWidth: 3,
      borderLeftColor: "transparent",
    },
    noteItemHover: {
      backgroundColor: semantic.sidebarHover,
    },
    noteItemSelected: {
      backgroundColor: semantic.sidebarActive,
      borderLeftColor: colors.primary[500],
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
      fontFamily: fontFamily.sans,
    },
    noteTitleSelected: {
      fontWeight: "600",
      color: semantic.sidebarActiveText,
    },
    trashButton: {
      marginLeft: spacing.xs,
      opacity: 1,
    },
    trashButtonHidden: {
      opacity: 0,
      // Prevent the invisible button from intercepting taps on the row body.
      pointerEvents: "none",
    },
    trashButtonText: {
      fontSize: fontSizes.xl,
      color: semantic.fgMuted,
    },
    noteDate: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      marginTop: spacing["2xs"],
      fontFamily: fontFamily.sans,
    },
    noteDateSelected: {
      color: semantic.sidebarActiveText,
      opacity: 0.75,
    },
  });
