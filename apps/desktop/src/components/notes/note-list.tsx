import { useMemo, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";

import { useAuth } from "@/providers/auth-provider";
import { useNotes } from "@/hooks/use-notes";
import { database, Note } from "@/db";
import { generateId } from "@/lib/generate-id";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { useTheme } from "@/providers/theme-provider";
import { EmptyState } from "@/components/ui/empty-state";

interface NoteListProps {
  notebookId: string | undefined;
  selectedNoteId: string | undefined;
  onSelectNote: (id: string) => void;
}

function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString();
}

function getPreview(content: string | null): string {
  if (!content) return "No content";
  try {
    const parsed = JSON.parse(content);
    // TipTap JSON: extract text from first content node
    if (parsed?.content) {
      for (const node of parsed.content) {
        if (node.content) {
          const text = node.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text: string }) => c.text)
            .join("");
          if (text.trim()) return text.trim();
        }
      }
    }
    return "No content";
  } catch {
    // Plain text content
    const trimmed = content.trim();
    return trimmed || "No content";
  }
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
          style={({ pressed }) => [styles.newButton, pressed && styles.newButtonPressed]}
          onPress={handleCreateNote}
        >
          <Text style={styles.newButtonText}>+ New</Text>
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
          {notes.map((note) => {
            const isSelected = note.id === selectedNoteId;

            return (
              <Pressable
                key={note.id}
                style={[styles.noteItem, isSelected && styles.noteItemSelected]}
                onPress={() => onSelectNote(note.id)}
              >
                <View style={styles.noteItemRow}>
                  <Text
                    style={[styles.noteTitle, isSelected && styles.noteTitleSelected]}
                    numberOfLines={1}
                  >
                    {note.title || "Untitled"}
                  </Text>
                  <Pressable
                    style={styles.trashButton}
                    onPress={() => handleTrashNote(note)}
                    hitSlop={8}
                  >
                    <Text style={styles.trashButtonText}>&times;</Text>
                  </Pressable>
                </View>
                <Text style={styles.notePreview} numberOfLines={1}>
                  {getPreview(note.content)}
                </Text>
                <Text style={styles.noteDate}>{formatDate(note.updatedAt)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
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
      padding: 12,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
    },
    headerTitle: {
      fontSize: 13,
      fontWeight: "600",
      color: semantic.fgMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    newButton: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: colors.primary[600],
    },
    newButtonPressed: {
      backgroundColor: colors.primary[700],
    },
    newButtonText: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.white,
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
      padding: 12,
      paddingHorizontal: 16,
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
      fontSize: 14,
      fontWeight: "500",
      color: semantic.fg,
      flex: 1,
    },
    noteTitleSelected: {
      fontWeight: "600",
    },
    trashButton: {
      marginLeft: 4,
      opacity: 0.4,
    },
    trashButtonText: {
      fontSize: 16,
      color: semantic.fgMuted,
    },
    notePreview: {
      fontSize: 12,
      color: semantic.fgMuted,
      marginTop: 2,
    },
    noteDate: {
      fontSize: 11,
      color: semantic.fgSubtle,
      marginTop: 4,
    },
  });
