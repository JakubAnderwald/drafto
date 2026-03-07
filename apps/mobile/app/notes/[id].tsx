import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  TextInput,
  ActivityIndicator,
  Text,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { useEditorBridge, TenTapStartKit } from "@10play/tentap-editor";

import { useDatabase } from "@/providers/database-provider";
import { useNote } from "@/hooks/use-note";
import { NoteEditor } from "@/components/editor/note-editor";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { useAutoSave } from "@/hooks/use-auto-save";
import type { Note } from "@/db";

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { database, sync } = useDatabase();
  const { note, loading, error } = useNote(id);
  const [title, setTitle] = useState("");
  const [editorReady, setEditorReady] = useState(false);
  const noteIdRef = useRef(id);

  const titleSave = useAutoSave<string>({
    onSave: useCallback(
      async (text: string) => {
        if (!id) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        await database.write(async () => {
          const record = await database.get<Note>("notes").find(id);
          await record.update((r) => {
            r.title = trimmed;
          });
        });
        sync();
      },
      [id, database, sync],
    ),
  });

  const contentSave = useAutoSave<void>({
    onSave: useCallback(async () => {
      if (!id || noteIdRef.current !== id) return;
      const json = await editor.getJSON();
      await database.write(async () => {
        const record = await database.get<Note>("notes").find(id);
        await record.update((r) => {
          r.content = JSON.stringify(json);
        });
      });
      sync();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, database, sync]),
  });

  const editor = useEditorBridge({
    bridgeExtensions: TenTapStartKit,
    autofocus: false,
    avoidIosKeyboard: true,
    onChange: () => {
      contentSave.trigger();
    },
  });

  useEffect(() => {
    contentSave.cancel();
    noteIdRef.current = id;
    setEditorReady(false);
  }, [id, contentSave]);

  useEffect(() => {
    if (!note || editorReady) return;

    setTitle(note.title);
    if (note.content) {
      try {
        const parsed = JSON.parse(note.content);
        editor.setContent(parsed as object);
      } catch {
        editor.setContent({ type: "doc", content: [] });
      }
    } else {
      editor.setContent({ type: "doc", content: [] });
    }
    setEditorReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

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

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
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
            placeholderTextColor="#9ca3af"
            returnKeyType="next"
          />
          {saveStatus === "saving" && <Text style={styles.statusText}>Saving...</Text>}
          {saveStatus === "saved" && <Text style={styles.statusTextSaved}>Saved</Text>}
          {saveStatus === "error" && <Text style={styles.statusTextError}>Save failed</Text>}
        </View>
        <View style={styles.editorContainer}>
          <NoteEditor editor={editor} />
        </View>
        <AttachmentPicker noteId={id} />
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fafaf9",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#fafaf9",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
  },
  titleInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: "700",
    color: "#111827",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  statusText: {
    fontSize: 12,
    color: "#9ca3af",
    paddingRight: 16,
  },
  statusTextSaved: {
    fontSize: 12,
    color: "#16a34a",
    paddingRight: 16,
  },
  statusTextError: {
    fontSize: 12,
    color: "#dc2626",
    paddingRight: 16,
  },
  editorContainer: {
    flex: 1,
  },
  errorText: {
    fontSize: 16,
    color: "#dc2626",
    textAlign: "center",
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: "#4f46e5",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
