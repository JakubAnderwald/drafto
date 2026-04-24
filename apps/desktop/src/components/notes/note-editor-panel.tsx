import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from "react-native";
import { useEditorBridge, TenTapStartKit } from "@10play/tentap-editor";

import { useNote } from "@/hooks/use-note";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useTheme } from "@/providers/theme-provider";
import { database, type Attachment } from "@/db";
import {
  contentToTiptap,
  tiptapToBlocknote,
  toAttachmentUrl,
  resolveTipTapImageUrls,
} from "@drafto/shared";
import type { TipTapDoc, TipTapNode } from "@drafto/shared";
import { getSignedUrl } from "@/lib/data";
import { colors, fontSizes, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { EmptyState } from "@/components/ui/empty-state";
import { NoteEditor } from "@/components/editor/note-editor";
import { AttachmentPicker } from "@/components/editor/attachment-picker";

function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

async function buildInsertNode(attachment: Attachment): Promise<TipTapNode> {
  const attachmentUrl = toAttachmentUrl(attachment.filePath);
  if (isImageMimeType(attachment.mimeType)) {
    // tentap's image node renders `<img src>` directly, so embed a signed URL
    // for this session; the save pipeline rewrites it back to attachment:// in
    // the DB and later loads resolve a fresh signed URL on demand.
    const signedUrl = await getSignedUrl(attachment.filePath);
    return { type: "image", attrs: { src: signedUrl, alt: attachment.fileName } };
  }
  return {
    type: "paragraph",
    content: [
      {
        type: "text",
        text: attachment.fileName,
        marks: [{ type: "link", attrs: { href: attachmentUrl } }],
      },
    ],
  };
}

interface NoteEditorPanelProps {
  noteId: string | undefined;
}

export function NoteEditorPanel({ noteId }: NoteEditorPanelProps) {
  const { note, loading } = useNote(noteId);
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

  // Track editor readiness — WebView initializes asynchronously.
  // Poll editor.getEditorState() to detect when the bridge is functional.
  const [editorReady, setEditorReady] = useState(false);

  // Use onChange callback from useEditorBridge for auto-save.
  // Capture note ID to prevent async getJSON() from saving to the wrong note
  // if the user switches notes before the promise resolves.
  // TenTap returns TipTap JSON; convert to BlockNote before saving so the
  // content stays compatible with the web editor (which uses BlockNote).
  const handleEditorChange = useCallback(() => {
    if (!editorRef.current) return;
    const capturedNoteId = noteIdRef.current;
    editorRef.current
      .getJSON()
      .then((json: object) => {
        if (noteIdRef.current !== capturedNoteId) return;
        const blocknote = tiptapToBlocknote(json as TipTapDoc);
        const jsonString = JSON.stringify(blocknote);
        contentAutoSaveRef.current?.trigger(jsonString);
      })
      .catch((err: unknown) => {
        console.warn("Editor getJSON failed:", err);
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

  // Detect when the editor WebView bridge is ready
  useEffect(() => {
    if (editorReady) return;
    const interval = setInterval(() => {
      try {
        // getJSON resolves only when the WebView bridge is functional
        editor
          .getJSON()
          .then(() => {
            setEditorReady(true);
            clearInterval(interval);
          })
          .catch(() => {
            // Not ready yet
          });
      } catch {
        // Not ready yet
      }
    }, 200);
    return () => clearInterval(interval);
  }, [editor, editorReady]);

  // Sync local state when a different note is loaded — wait for editor to be ready.
  // `attachment://` URLs are resolved to signed URLs before loading so tentap can
  // actually render images/file links inside the WebView.
  useEffect(() => {
    if (!editorReady) return;

    if (note && note.id !== noteIdRef.current) {
      noteIdRef.current = note.id;
      setTitle(note.title || "");

      const rawContent = note.content || "";
      let cancelled = false;

      (async () => {
        try {
          if (!rawContent) {
            editor.setContent("");
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawContent);
          } catch {
            // Not JSON — treat as plain text
            const htmlContent = rawContent
              .split("\n")
              .map((line: string) => `<p>${escapeHtml(line) || "<br>"}</p>`)
              .join("");
            editor.setContent(htmlContent);
            return;
          }
          const isBlockNote =
            Array.isArray(parsed) && parsed.length > 0 && (parsed[0] as { type?: string })?.type;
          const isTipTap =
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            (parsed as { type?: string }).type === "doc";
          if (!isBlockNote && !isTipTap) {
            const htmlContent = rawContent
              .split("\n")
              .map((line: string) => `<p>${escapeHtml(line) || "<br>"}</p>`)
              .join("");
            editor.setContent(htmlContent);
            return;
          }
          const tiptapDoc = contentToTiptap(parsed);
          const resolved = await resolveTipTapImageUrls(tiptapDoc, getSignedUrl);
          if (cancelled || noteIdRef.current !== note.id) return;
          editor.setContent(resolved);
        } catch (err) {
          console.warn("Failed to set editor content:", err);
          if (!cancelled) editor.setContent("");
        }
      })();

      return () => {
        cancelled = true;
      };
    } else if (!note) {
      noteIdRef.current = undefined;
      setTitle("");
      try {
        editor.setContent("");
      } catch {
        // Editor not ready — safe to ignore
      }
    }
  }, [note?.id, editor, editorReady]);

  const handleAttachmentReady = useCallback(
    async (attachment: Attachment) => {
      try {
        const node = await buildInsertNode(attachment);
        const currentJson = (await editor.getJSON()) as TipTapDoc;
        const appended: TipTapDoc = {
          type: "doc",
          content: [...(currentJson.content ?? []), node],
        };
        editor.setContent(appended);
        // setContent doesn't always fire the editor's onChange path reliably —
        // persist explicitly so sync doesn't strand the inline reference.
        const blocks = tiptapToBlocknote(appended);
        await database.write(async () => {
          if (!note) return;
          await note.update((n) => {
            n.content = JSON.stringify(blocks);
          });
        });
      } catch (err) {
        console.warn("Failed to insert attachment inline:", err);
      }
    },
    [editor, note],
  );

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

      {noteId && <AttachmentPicker noteId={noteId} onAttachmentReady={handleAttachmentReady} />}
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
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
      minHeight: 36,
    },
    saveStatus: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
    },
    titleInput: {
      fontSize: fontSizes["3xl"],
      fontWeight: "700",
      color: semantic.fg,
      paddingHorizontal: spacing["2xl"],
      paddingTop: spacing.xl,
      paddingBottom: spacing.sm,
      fontFamily: "System",
    },
    editorContainer: {
      flex: 1,
      minHeight: 0,
    },
  });
