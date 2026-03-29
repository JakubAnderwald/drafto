import { useMemo, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";

import { useTrashedNotes } from "@/hooks/use-trashed-notes";
import { database, Note } from "@/db";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { useTheme } from "@/providers/theme-provider";
import { EmptyState } from "@/components/ui/empty-state";

export function TrashList() {
  const { notes, loading } = useTrashedNotes();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const handleRestore = useCallback(async (note: Note) => {
    await database.write(async () => {
      await note.update((n) => {
        n.isTrashed = false;
        n.trashedAt = null;
      });
    });
  }, []);

  const handleDeletePermanently = useCallback(async (note: Note) => {
    await database.write(async () => {
      await note.markAsDeleted();
    });
  }, []);

  if (loading) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="small" color={colors.primary[600]} />
      </View>
    );
  }

  if (notes.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Trash</Text>
        </View>
        <EmptyState icon="🗑️" title="Trash is empty" subtitle="Deleted notes will appear here" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Trash</Text>
        <Text style={styles.headerCount}>{notes.length}</Text>
      </View>

      <ScrollView style={styles.list}>
        {notes.map((note) => (
          <View key={note.id} style={styles.noteItem}>
            <Text style={styles.noteTitle} numberOfLines={1}>
              {note.title || "Untitled"}
            </Text>
            {note.trashedAt && (
              <Text style={styles.noteDate}>Deleted {note.trashedAt.toLocaleDateString()}</Text>
            )}
            <View style={styles.actions}>
              <Pressable
                style={({ pressed }) => [styles.restoreButton, pressed && styles.buttonPressed]}
                onPress={() => handleRestore(note)}
              >
                <Text style={styles.restoreText}>Restore</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.deleteButton, pressed && styles.buttonPressed]}
                onPress={() => handleDeletePermanently(note)}
              >
                <Text style={styles.deleteText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: semantic.bg,
    },
    loadingContainer: {
      alignItems: "center",
      justifyContent: "center",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      padding: 12,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
      gap: 8,
    },
    headerTitle: {
      fontSize: 13,
      fontWeight: "600",
      color: semantic.fgMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    headerCount: {
      fontSize: 11,
      color: semantic.fgSubtle,
      backgroundColor: semantic.bgMuted,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 8,
      overflow: "hidden",
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
    noteTitle: {
      fontSize: 14,
      fontWeight: "500",
      color: semantic.fg,
    },
    noteDate: {
      fontSize: 11,
      color: semantic.fgSubtle,
      marginTop: 2,
    },
    actions: {
      flexDirection: "row",
      gap: 8,
      marginTop: 8,
    },
    restoreButton: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 4,
      backgroundColor: colors.primary[50],
    },
    deleteButton: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 4,
      backgroundColor: semantic.errorBg,
    },
    buttonPressed: {
      opacity: 0.7,
    },
    restoreText: {
      fontSize: 12,
      fontWeight: "500",
      color: colors.primary[600],
    },
    deleteText: {
      fontSize: 12,
      fontWeight: "500",
      color: semantic.errorText,
    },
  });
