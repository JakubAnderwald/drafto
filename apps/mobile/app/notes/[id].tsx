import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  View,
  TextInput,
  Text,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { useEditorBridge, TenTapStartKit, darkEditorTheme } from "@10play/tentap-editor";

import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNote } from "@/hooks/use-note";
import { useAttachments } from "@/hooks/use-attachments";
import { NoteEditor } from "@/components/editor/note-editor";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { AttachmentList } from "@/components/editor/attachment-list";
import { EditorSkeleton } from "@/components/ui/skeleton";
import { useAutoSave } from "@/hooks/use-auto-save";
import { contentToTiptap, contentToBlocknote } from "@drafto/shared";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Note } from "@/db";

function parseInitialContent(note: Note): object {
  if (note.content) {
    try {
      return contentToTiptap(JSON.parse(note.content));
    } catch {
      return { type: "doc", content: [] };
    }
  }
  return { type: "doc", content: [] };
}

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { note, loading, error } = useNote(id);
  const { sync } = useDatabase();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  if (loading) {
    return <EditorSkeleton />;
  }

  if (error || !note) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? "Note not found"}</Text>
        <Pressable style={styles.retryButton} onPress={() => sync()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  // Render the editor only once the note is loaded so we can pass
  // initialContent to useEditorBridge — this avoids the race condition
  // where setContent is called before the TenTap WebView finishes initializing.
  return <NoteEditorView key={id} noteId={id} initialNote={note} />;
}

interface NoteEditorViewProps {
  noteId: string;
  initialNote: Note;
}

function NoteEditorView({ noteId, initialNote }: NoteEditorViewProps) {
  const { database, sync } = useDatabase();
  const { semantic, isDark } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const { attachments } = useAttachments(noteId);
  const [title, setTitle] = useState(initialNote.title);
  const noteIdRef = useRef(noteId);

  const titleSave = useAutoSave<string>({
    onSave: useCallback(
      async (text: string) => {
        if (!noteId) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        await database.write(async () => {
          const record = await database.get<Note>("notes").find(noteId);
          await record.update((r) => {
            r.title = trimmed;
          });
        });
        sync();
      },
      [noteId, database, sync],
    ),
  });

  const contentSave = useAutoSave<void>({
    onSave: useCallback(async () => {
      if (!noteId || noteIdRef.current !== noteId) return;
      const json = await editor.getJSON();
      await database.write(async () => {
        const record = await database.get<Note>("notes").find(noteId);
        await record.update((r) => {
          r.content = JSON.stringify(contentToBlocknote(json));
        });
      });
      sync();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId, database, sync]),
  });

  // Pass initialContent so TipTap has the content when it first initializes
  // inside the WebView — no race condition with setContent.
  const editor = useEditorBridge({
    bridgeExtensions: TenTapStartKit,
    autofocus: false,
    avoidIosKeyboard: true,
    initialContent: parseInitialContent(initialNote),
    theme: isDark
      ? {
          ...darkEditorTheme,
          webview: { backgroundColor: semantic.bg },
        }
      : undefined,
    onChange: () => {
      contentSave.trigger();
    },
  });

  useEffect(() => {
    const css = isDark
      ? `
        * { background-color: ${semantic.bg}; color: ${semantic.fg}; }
        blockquote { border-left: 3px solid ${semantic.borderStrong}; padding-left: 1rem; }
        .highlight-background { background-color: ${semantic.bgMuted}; }
      `
      : `* { background-color: ${semantic.bg}; color: ${semantic.fg}; }`;
    editor.injectCSS(css, "dark-mode");
  }, [isDark, semantic, editor]);

  useEffect(() => {
    contentSave.cancel();
    noteIdRef.current = noteId;
  }, [noteId, contentSave]);

  const handleTitleChange = (text: string) => {
    setTitle(text);
    titleSave.trigger(text);
  };

  const saveStatus =
    titleSave.status === "saving" || contentSave.status === "saving"
      ? "saving"
      : titleSave.status === "error" || contentSave.status === "error"
        ? "error"
        : titleSave.status === "saved" || contentSave.status === "saved"
          ? "saved"
          : "idle";

  return (
    <>
      <Stack.Screen options={{ title: title || "Untitled" }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.titleRow}>
          <TextInput
            style={styles.titleInput}
            value={title}
            onChangeText={handleTitleChange}
            placeholder="Untitled"
            placeholderTextColor={semantic.fgSubtle}
            returnKeyType="next"
          />
          {saveStatus === "saving" && <Text style={styles.statusText}>Saving...</Text>}
          {saveStatus === "saved" && <Text style={styles.statusTextSaved}>Saved</Text>}
          {saveStatus === "error" && <Text style={styles.statusTextError}>Save failed</Text>}
        </View>
        <View style={styles.editorContainer}>
          <NoteEditor editor={editor} />
        </View>
        <AttachmentList attachments={attachments} />
        <AttachmentPicker noteId={noteId} />
      </KeyboardAvoidingView>
    </>
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
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: semantic.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: semantic.border,
    },
    titleInput: {
      flex: 1,
      fontSize: 22,
      fontWeight: "700",
      color: semantic.fg,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    statusText: {
      fontSize: 12,
      color: semantic.fgSubtle,
      paddingRight: 16,
    },
    statusTextSaved: {
      fontSize: 12,
      color: semantic.successText,
      paddingRight: 16,
    },
    statusTextError: {
      fontSize: 12,
      color: semantic.errorText,
      paddingRight: 16,
    },
    editorContainer: {
      flex: 1,
    },
    errorText: {
      fontSize: 16,
      color: semantic.errorText,
      textAlign: "center",
      marginBottom: 16,
    },
    retryButton: {
      backgroundColor: colors.primary[600],
      borderRadius: 8,
      paddingVertical: 10,
      paddingHorizontal: 20,
    },
    retryText: {
      color: semantic.onPrimary,
      fontSize: 16,
      fontWeight: "600",
    },
  });
