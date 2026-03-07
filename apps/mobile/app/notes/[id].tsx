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
import type { Json, NoteRow } from "@drafto/shared";

import { getNote, updateNote } from "@/lib/data";
import { NoteEditor } from "@/components/editor/note-editor";

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [note, setNote] = useState<NoteRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const titleSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteIdRef = useRef(id);

  const editor = useEditorBridge({
    bridgeExtensions: TenTapStartKit,
    autofocus: false,
    avoidIosKeyboard: true,
    onChange: () => {
      scheduleContentSave();
    },
  });

  const scheduleContentSave = useCallback(() => {
    if (!id) return;
    if (contentSaveTimerRef.current) {
      clearTimeout(contentSaveTimerRef.current);
    }
    const saveNoteId = id;
    contentSaveTimerRef.current = setTimeout(async () => {
      if (noteIdRef.current !== saveNoteId) return;
      try {
        const json = await editor.getJSON();
        await updateNote(saveNoteId, { content: json as Json });
      } catch (err) {
        console.error("[auto-save] content save failed:", err);
      }
    }, 500);
  }, [editor, id]);

  useEffect(() => {
    if (contentSaveTimerRef.current) {
      clearTimeout(contentSaveTimerRef.current);
    }
    noteIdRef.current = id;
  }, [id]);

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function loadNote() {
      try {
        setLoading(true);
        setError(null);
        const data = await getNote(id!);
        if (cancelled) return;
        setNote(data);
        setTitle(data.title);
        if (data.content) {
          editor.setContent(data.content as object);
        } else {
          editor.setContent({ type: "doc", content: [] });
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load note");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadNote();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    return () => {
      if (titleSaveTimerRef.current) clearTimeout(titleSaveTimerRef.current);
      if (contentSaveTimerRef.current) clearTimeout(contentSaveTimerRef.current);
    };
  }, []);

  const handleTitleChange = (text: string) => {
    setTitle(text);
    if (titleSaveTimerRef.current) {
      clearTimeout(titleSaveTimerRef.current);
    }
    titleSaveTimerRef.current = setTimeout(async () => {
      if (!id) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        await updateNote(id, { title: trimmed });
      } catch (err) {
        console.error("[auto-save] title save failed:", err);
      }
    }, 500);
  };

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
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            setLoading(true);
            setError(null);
            getNote(id!)
              .then((data) => {
                setNote(data);
                setTitle(data.title);
                if (data.content) {
                  editor.setContent(data.content as object);
                } else {
                  editor.setContent({ type: "doc", content: [] });
                }
              })
              .catch((err) => {
                setError(err instanceof Error ? err.message : "Failed to load note");
              })
              .finally(() => setLoading(false));
          }}
        >
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
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={handleTitleChange}
          placeholder="Untitled"
          placeholderTextColor="#9ca3af"
          returnKeyType="next"
        />
        <View style={styles.editorContainer}>
          <NoteEditor editor={editor} />
        </View>
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
  titleInput: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111827",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
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
