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
import {
  useEditorBridge,
  useBridgeState,
  TenTapStartKit,
  darkEditorTheme,
} from "@10play/tentap-editor";

import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNote } from "@/hooks/use-note";
import { NoteEditor } from "@/components/editor/note-editor";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { EditorSkeleton } from "@/components/ui/skeleton";
import { useAutoSave } from "@/hooks/use-auto-save";
import {
  contentToTiptap,
  contentToBlocknote,
  migrateSignedUrlsToAttachmentUrls,
  resolveTipTapImageUrls,
  isAttachmentUrl,
  toAttachmentUrl,
} from "@drafto/shared";
import type { TipTapDoc, TipTapNode } from "@drafto/shared";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Note, Attachment } from "@/db";

function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

const EMPTY_DOC: TipTapDoc = { type: "doc", content: [] };

function parseInitialContent(note: Note): TipTapDoc {
  if (note.content) {
    try {
      return contentToTiptap(JSON.parse(note.content));
    } catch {
      return EMPTY_DOC;
    }
  }
  return EMPTY_DOC;
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

function hasAttachmentUrls(nodes: TipTapNode[]): boolean {
  for (const node of nodes) {
    if (
      node.type === "image" &&
      typeof node.attrs?.src === "string" &&
      isAttachmentUrl(node.attrs.src)
    ) {
      return true;
    }
    if (node.content && hasAttachmentUrls(node.content)) {
      return true;
    }
  }
  return false;
}

function useResolvedContent(note: Note): { content: TipTapDoc; resolving: boolean } {
  const parsed = useMemo(() => parseInitialContent(note), [note]);
  const needsResolving = useMemo(() => hasAttachmentUrls(parsed.content), [parsed]);

  const [content, setContent] = useState<TipTapDoc>(parsed);
  const [resolving, setResolving] = useState(needsResolving);

  useEffect(() => {
    if (!needsResolving) return;
    let cancelled = false;
    // Dynamic import to avoid loading Supabase client at module level (breaks tests)
    import("@/lib/data/attachments")
      .then(({ getSignedUrl }) => resolveTipTapImageUrls(parsed, getSignedUrl))
      .then((resolved) => {
        if (!cancelled) {
          setContent(resolved);
          setResolving(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent(parsed);
          setResolving(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [parsed, needsResolving]);

  return { content, resolving };
}

function NoteEditorView({ noteId, initialNote }: NoteEditorViewProps) {
  const { database, sync } = useDatabase();
  const { semantic, isDark } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [title, setTitle] = useState(initialNote.title);
  const noteIdRef = useRef(noteId);
  // Gate autosave on TenTap's readiness. Without this, onChange emissions during
  // WebView bootstrap (before initialContent has actually hydrated the editor)
  // can trigger a save that reads an empty/partial editor state and clobbers
  // the note — the same class of race that corrupted prod data on 2026-04-24.
  const editorReadyRef = useRef(false);
  const { content: resolvedContent, resolving } = useResolvedContent(initialNote);

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
      const blocks = contentToBlocknote(json);
      const migrated = migrateSignedUrlsToAttachmentUrls(blocks);
      await database.write(async () => {
        const record = await database.get<Note>("notes").find(noteId);
        await record.update((r) => {
          r.content = JSON.stringify(migrated);
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
    initialContent: resolvedContent,
    theme: isDark
      ? {
          ...darkEditorTheme,
          webview: { backgroundColor: semantic.bg },
        }
      : undefined,
    onChange: () => {
      if (!editorReadyRef.current) return;
      contentSave.trigger();
    },
  });

  const { isReady } = useBridgeState(editor);

  useEffect(() => {
    editorReadyRef.current = isReady;
  }, [isReady]);

  useEffect(() => {
    if (!isReady) return;
    const css = isDark
      ? `
        * { background-color: ${semantic.bg}; color: ${semantic.fg}; }
        blockquote { border-left: 3px solid ${semantic.borderStrong}; padding-left: 1rem; }
        .highlight-background { background-color: ${semantic.bgMuted}; }
      `
      : `* { background-color: ${semantic.bg}; color: ${semantic.fg}; }`;
    editor.injectCSS(css, "dark-mode");
  }, [isDark, semantic, editor, isReady]);

  const { flush: flushContent } = contentSave;

  useEffect(() => {
    flushContent();
    noteIdRef.current = noteId;
  }, [noteId, flushContent]);

  const handleTitleChange = (text: string) => {
    setTitle(text);
    titleSave.trigger(text);
  };

  const handleAttachmentReady = useCallback(
    async (attachment: Attachment) => {
      try {
        let node: TipTapNode;
        if (isImageMimeType(attachment.mimeType)) {
          // Default to attachment:// so a getSignedUrl failure (offline, expired
          // session, storage outage) still inserts a recoverable node rather than
          // bailing out and leaving the attachment row orphaned.
          let src = toAttachmentUrl(attachment.filePath);
          try {
            const { getSignedUrl } = await import("@/lib/data/attachments");
            src = await getSignedUrl(attachment.filePath);
          } catch (err) {
            console.warn("getSignedUrl failed; falling back to attachment://", err);
          }
          node = { type: "image", attrs: { src, alt: attachment.fileName } };
        } else {
          node = {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: attachment.fileName,
                marks: [
                  {
                    type: "link",
                    attrs: { href: toAttachmentUrl(attachment.filePath) },
                  },
                ],
              },
            ],
          };
        }
        const currentJson = (await editor.getJSON()) as TipTapDoc;
        const appended: TipTapDoc = {
          type: "doc",
          content: [...(currentJson.content ?? []), node],
        };
        editor.setContent(appended);
        const blocks = contentToBlocknote(appended);
        const migrated = migrateSignedUrlsToAttachmentUrls(blocks);
        await database.write(async () => {
          const record = await database.get<Note>("notes").find(noteId);
          await record.update((r) => {
            r.content = JSON.stringify(migrated);
          });
        });
        sync();
      } catch (err) {
        console.warn("Failed to insert attachment inline:", err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [noteId, database, sync],
  );

  const saveStatus =
    titleSave.status === "saving" || contentSave.status === "saving"
      ? "saving"
      : titleSave.status === "error" || contentSave.status === "error"
        ? "error"
        : titleSave.status === "saved" || contentSave.status === "saved"
          ? "saved"
          : "idle";

  if (resolving) {
    return <EditorSkeleton />;
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
        <AttachmentPicker noteId={noteId} onAttachmentReady={handleAttachmentReady} />
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
      padding: spacing["2xl"],
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
      fontSize: fontSizes["3xl"],
      fontWeight: "700",
      color: semantic.fg,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    statusText: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      paddingRight: spacing.lg,
    },
    statusTextSaved: {
      fontSize: fontSizes.sm,
      color: semantic.successText,
      paddingRight: spacing.lg,
    },
    statusTextError: {
      fontSize: fontSizes.sm,
      color: semantic.errorText,
      paddingRight: spacing.lg,
    },
    editorContainer: {
      flex: 1,
    },
    errorText: {
      fontSize: fontSizes.xl,
      color: semantic.errorText,
      textAlign: "center",
      marginBottom: spacing.lg,
    },
    retryButton: {
      backgroundColor: colors.primary[600],
      borderRadius: radii.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.xl,
    },
    retryText: {
      color: semantic.onPrimary,
      fontSize: fontSizes.xl,
      fontWeight: "600",
    },
  });
