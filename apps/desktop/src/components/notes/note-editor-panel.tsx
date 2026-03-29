import { useState, useMemo, useCallback, useEffect } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from "react-native";

import { useNote } from "@/hooks/use-note";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useTheme } from "@/providers/theme-provider";
import { database } from "@/db";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { EmptyState } from "@/components/ui/empty-state";

interface NoteEditorPanelProps {
  noteId: string | undefined;
}

export function NoteEditorPanel({ noteId }: NoteEditorPanelProps) {
  const { note, loading } = useNote(noteId);
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  // Sync local state when a different note is loaded
  useEffect(() => {
    if (note) {
      setTitle(note.title || "");
      // For Phase 3, display content as plain text.
      // Phase 4 will integrate TenTap for rich text editing.
      setContent(note.content || "");
    } else {
      setTitle("");
      setContent("");
    }
  }, [note?.id]);

  const handleSaveTitle = useCallback(
    async (newTitle: string) => {
      if (!note) return;
      await database.write(async () => {
        await note.update((n) => {
          n.title = newTitle;
        });
      });
    },
    [note],
  );

  const handleSaveContent = useCallback(
    async (newContent: string) => {
      if (!note) return;
      await database.write(async () => {
        await note.update((n) => {
          n.content = newContent;
        });
      });
    },
    [note],
  );

  const titleAutoSave = useAutoSave<string>({ onSave: handleSaveTitle });
  const contentAutoSave = useAutoSave<string>({ onSave: handleSaveContent });

  const handleTitleChange = useCallback(
    (text: string) => {
      setTitle(text);
      titleAutoSave.trigger(text);
    },
    [titleAutoSave],
  );

  const handleContentChange = useCallback(
    (text: string) => {
      setContent(text);
      contentAutoSave.trigger(text);
    },
    [contentAutoSave],
  );

  if (!noteId) {
    return (
      <View style={styles.container}>
        <EmptyState
          icon="✏️"
          title="Select a note"
          subtitle="Choose a note from the list to start editing"
        />
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="small" color={colors.primary[600]} />
      </View>
    );
  }

  const saveStatus =
    titleAutoSave.status === "saving" || contentAutoSave.status === "saving"
      ? "Saving..."
      : titleAutoSave.status === "error" || contentAutoSave.status === "error"
        ? "Error saving"
        : titleAutoSave.status === "saved" || contentAutoSave.status === "saved"
          ? "Saved"
          : "";

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        {saveStatus !== "" && <Text style={styles.saveStatus}>{saveStatus}</Text>}
      </View>

      <TextInput
        style={styles.titleInput}
        value={title}
        onChangeText={handleTitleChange}
        placeholder="Note title"
        placeholderTextColor={semantic.fgSubtle}
      />

      <TextInput
        style={styles.contentInput}
        value={content}
        onChangeText={handleContentChange}
        placeholder="Start writing..."
        placeholderTextColor={semantic.fgSubtle}
        multiline
        textAlignVertical="top"
      />
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
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
      minHeight: 36,
    },
    saveStatus: {
      fontSize: 11,
      color: semantic.fgSubtle,
    },
    titleInput: {
      fontSize: 22,
      fontWeight: "700",
      color: semantic.fg,
      paddingHorizontal: 24,
      paddingTop: 20,
      paddingBottom: 8,
    },
    contentInput: {
      flex: 1,
      fontSize: 14,
      lineHeight: 22,
      color: semantic.fg,
      paddingHorizontal: 24,
      paddingTop: 0,
      paddingBottom: 24,
    },
  });
