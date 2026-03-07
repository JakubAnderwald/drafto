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
import { useAutoSave } from "@/hooks/use-auto-save";

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [note, setNote] = useState<NoteRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const noteIdRef = useRef(id);

  const titleSave = useAutoSave<string>({
    onSave: useCallback(
      async (text: string) => {
        if (!id) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        await updateNote(id, { title: trimmed });
      },
      [id],
    ),
  });

  const contentSave = useAutoSave<void>({
    onSave: useCallback(async () => {
      if (!id || noteIdRef.current !== id) return;
      const json = await editor.getJSON();
      await updateNote(id, { content: json as Json });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]),
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
  }, [id, contentSave]);

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
