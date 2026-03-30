import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import { useEditorBridge, TenTapStartKit } from "@10play/tentap-editor";

import { useNote } from "@/hooks/use-note";
import { useAttachments } from "@/hooks/use-attachments";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useTheme } from "@/providers/theme-provider";
import { database } from "@/db";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { EmptyState } from "@/components/ui/empty-state";
import { NoteEditor } from "@/components/editor/note-editor";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { AttachmentList } from "@/components/editor/attachment-list";

interface NoteEditorPanelProps {
  noteId: string | undefined;
}

export function NoteEditorPanel({ noteId }: NoteEditorPanelProps) {
  const { note, loading } = useNote(noteId);
  const { attachments } = useAttachments(noteId);
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [title, setTitle] = useState("");
  const noteIdRef = useRef<string | undefined>(undefined);
  const contentAutoSaveRef = useRef<{ trigger: (v: string) => void } | null>(null);

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
  contentAutoSaveRef.current = contentAutoSave;

  // Use onChange callback from useEditorBridge for auto-save.
  // Capture note ID to prevent async getJSON() from saving to the wrong note
  // if the user switches notes before the promise resolves.
  const handleEditorChange = useCallback(() => {
    if (!editorRef.current) return;
    const capturedNoteId = noteIdRef.current;
    editorRef.current.getJSON().then((json: object) => {
      if (noteIdRef.current !== capturedNoteId) return;
      const jsonString = JSON.stringify(json);
      contentAutoSaveRef.current?.trigger(jsonString);
    });
  }, []);

  const editorRef = useRef<ReturnType<typeof useEditorBridge> | null>(null);
  const editor = useEditorBridge({
    autofocus: false,
    avoidIosKeyboard: false,
    bridgeExtensions: TenTapStartKit,
    initialContent: "",
    onChange: handleEditorChange,
  });
  editorRef.current = editor;

  // Sync local state when a different note is loaded
  useEffect(() => {
    if (note && note.id !== noteIdRef.current) {
      noteIdRef.current = note.id;
      setTitle(note.title || "");

      // Parse content: may be TipTap JSON string, plain text, or null
      const rawContent = note.content || "";

      if (rawContent) {
        try {
          const parsed = JSON.parse(rawContent);
          // If it's a TipTap document, set it as JSON
          if (parsed && typeof parsed === "object" && parsed.type === "doc") {
            editor.setContent(parsed);
            return;
          }
        } catch {
          // Not JSON — treat as plain text
        }
        // Convert plain text to simple HTML for the editor
        const htmlContent = rawContent
          .split("\n")
          .map((line: string) => `<p>${escapeHtml(line) || "<br>"}</p>`)
          .join("");
        editor.setContent(htmlContent);
      } else {
        editor.setContent("");
      }
    } else if (!note) {
      noteIdRef.current = undefined;
      setTitle("");
      editor.setContent("");
    }
  }, [note?.id, editor]);

  // Flush pending autosaves when switching notes
  useEffect(() => {
    return () => {
      titleAutoSave.flush();
      contentAutoSave.flush();
    };
  }, [note?.id, titleAutoSave.flush, contentAutoSave.flush]);

  const handleTitleChange = useCallback(
    (text: string) => {
      setTitle(text);
      titleAutoSave.trigger(text);
    },
    [titleAutoSave],
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

      <View style={styles.editorContainer}>
        <NoteEditor editor={editor} />
      </View>

      {noteId && (
        <ScrollView style={styles.attachmentsSection}>
          <AttachmentList attachments={attachments} />
          <AttachmentPicker noteId={noteId} />
        </ScrollView>
      )}
    </View>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
    editorContainer: {
      flex: 1,
    },
    attachmentsSection: {
      maxHeight: 300,
    },
  });
