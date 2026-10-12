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
import { useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEditorBridge, useBridgeState, TenTapStartKit, CoreBridge } from "@10play/tentap-editor";

import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNote } from "@/hooks/use-note";
import { useKeyboardVisible } from "@/hooks/use-keyboard-visible";
import { NoteEditor } from "@/components/editor/note-editor";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { EditorSkeleton } from "@/components/ui/skeleton";
import { useAutoSave } from "@/hooks/use-auto-save";
import { buildEditorColorCss, buildEditorCss } from "@/lib/editor-css";
import { buildEditorTheme } from "@/lib/editor-theme";
import {
  contentToTiptap,
  contentToBlocknote,
  migrateSignedUrlsToAttachmentUrls,
  resolveTipTapImageUrls,
  isAttachmentUrl,
  toAttachmentUrl,
  isNoOpContentSave,
  rememberContentBaseline,
  serializeEditorContent,
  serializeLoadedDoc,
  withTimeout,
} from "@drafto/shared";
import type { ContentBaseline, TipTapDoc, TipTapNode } from "@drafto/shared";
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

// Bound on reading the editor back once it is ready to add that serialisation
// to the no-op-save baseline. Content saves wait for the read, so a stuck
// WebView reply must not hold them up for long.
const BASELINE_READ_TIMEOUT_MS = 3000;

/**
 * The no-op-save baseline for a note as it was loaded (issue #654, shared with
 * desktop): its stored content, plus the converter's serialisation of the doc
 * the editor is handed. The editor's own read-back joins it once it is ready.
 */
function createLoadBaseline(note: Note): ContentBaseline {
  const stored = note.content;
  try {
    return { stored, serializations: [serializeLoadedDoc(parseInitialContent(note))] };
  } catch (err) {
    console.warn("[editor] baseline serialisation failed", err);
    return { stored, serializations: [] };
  }
}

/**
 * A document's text with no separators. ProseMirror's load normalisation
 * (merging text runs, re-sorting marks, filling an empty doc) keeps it; typing
 * changes it.
 */
function docText(node: { text?: string; content?: TipTapNode[] }): string {
  return (node.text ?? "") + (node.content ?? []).map(docText).join("");
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
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const isKeyboardUp = useKeyboardVisible();
  const [title, setTitle] = useState(initialNote.title);
  const noteIdRef = useRef(noteId);
  // Gate autosave on TenTap's readiness. Without this, onChange emissions during
  // WebView bootstrap (before initialContent has actually hydrated the editor)
  // can trigger a save that reads an empty/partial editor state and clobbers
  // the note — the same class of race that corrupted prod data on 2026-04-24.
  const editorReadyRef = useRef(false);
  const { content: resolvedContent, resolving } = useResolvedContent(initialNote);
  // Serialisations of the content this note was loaded with that a save may
  // write back without changing anything. TenTap answers the load with a
  // content-update of its own, and writing that echo bumped updated_at, showed
  // "Saved" on a note nobody had typed in, and pushed a phantom modification
  // to every device. Created once per mount (the view is keyed by note id).
  const [contentBaselines] = useState(
    () => new Map<string, ContentBaseline>([[noteId, createLoadBaseline(initialNote)]]),
  );
  const [loadedText] = useState(() => docText(parseInitialContent(initialNote)));
  // Settles once the editor's read-back has joined the baseline (or timed out);
  // content saves wait for it so the load echo is compared against it.
  const baselineSeedRef = useRef<Promise<void>>(Promise.resolve());

  // Both save handlers resolve false when they wrote nothing, which keeps the
  // status at "idle" and skips the sync (WatermelonDB bumps updated_at on every
  // update, so an unchanged write is not harmless). Each compares inside the
  // writer, so it sees whatever earlier writes produced.
  const titleSave = useAutoSave<string>({
    onSave: useCallback(
      async (text: string): Promise<boolean> => {
        if (!noteId) return false;
        const trimmed = text.trim();
        if (!trimmed) return false;
        const written = await database.write(async () => {
          const record = await database.get<Note>("notes").find(noteId);
          if (record.title === trimmed) return false;
          await record.update((r) => {
            r.title = trimmed;
          });
          return true;
        });
        if (written) sync();
        return written;
      },
      [noteId, database, sync],
    ),
  });

  const contentSave = useAutoSave<void>({
    onSave: useCallback(async (): Promise<boolean> => {
      if (!noteId || noteIdRef.current !== noteId) return false;
      await baselineSeedRef.current;
      const json = await editor.getJSON();
      const payload = { noteId, content: serializeEditorContent(json as TipTapDoc) };
      const written = await database.write(async () => {
        const record = await database.get<Note>("notes").find(noteId);
        // Once anything really changes the row, the load baseline stops
        // applying (it is tied to the stored content it was taken against).
        if (isNoOpContentSave(contentBaselines, payload, record.content)) return false;
        await record.update((r) => {
          r.content = payload.content;
        });
        return true;
      });
      if (written) sync();
      return written;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId, database, sync, contentBaselines]),
  });

  // Font and colours are set through CoreBridge so they ship with the editor's
  // initial load and are re-applied whenever the WebView reloads. A post-load
  // injectCSS alone is lost on reload, leaving dark text on the dark background.
  const bridgeExtensions = useMemo(
    () => [...TenTapStartKit, CoreBridge.configureCSS(buildEditorCss(semantic, isDark))],
    [semantic, isDark],
  );

  // Memoised: TenTap re-merges its theme whenever this object changes.
  const editorTheme = useMemo(() => buildEditorTheme(semantic, isDark), [semantic, isDark]);

  // Pass initialContent so TipTap has the content when it first initializes
  // inside the WebView — no race condition with setContent.
  const editor = useEditorBridge({
    bridgeExtensions,
    autofocus: false,
    // The KeyboardAvoidingView below already lifts the editor above the
    // keyboard. TenTap's own avoidance would also pad the document by the
    // keyboard height, leaving a blank band above the toolbar.
    avoidIosKeyboard: false,
    initialContent: resolvedContent,
    theme: editorTheme,
    onChange: () => {
      if (!editorReadyRef.current) return;
      contentSave.trigger();
    },
  });

  const { isReady } = useBridgeState(editor);
  // useEditorBridge returns a new object every render; effects read the live
  // one through this ref instead of depending on it.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    if (isReady) {
      // Read the loaded document back and add its serialisation to the
      // baseline: ProseMirror normalises what it loads (an empty doc gains a
      // paragraph, adjacent text runs merge), and the load's content-update
      // echo serialises to that. The reply must not hold a user edit, or the
      // baseline would make that edit look like a no-op and drop it. So the
      // read-back is refused if the editor was focused at any point before the
      // reply (typing needs focus, and bridge state updates reach us in order,
      // ahead of the reply), or if its text differs from the loaded doc's.
      const liveEditor = editorRef.current;
      let focused = liveEditor.getEditorState().isFocused;
      const unsubscribe = liveEditor._subscribeToEditorStateUpdate((state) => {
        if (state.isFocused) focused = true;
      });
      baselineSeedRef.current = withTimeout<object | null>(
        liveEditor.getJSON(),
        BASELINE_READ_TIMEOUT_MS,
        null,
      ).then((json) => {
        // Never rejects: content saves await this promise.
        try {
          unsubscribe();
          const baseline = contentBaselines.get(noteId);
          if (!json || !baseline || focused) return;
          const readBack = json as TipTapDoc;
          if (docText(readBack) !== loadedText) return;
          rememberContentBaseline(contentBaselines, noteId, {
            stored: baseline.stored,
            serializations: [...baseline.serializations, serializeEditorContent(readBack)],
          });
        } catch (err) {
          console.warn("[editor] baseline read-back failed", err);
        }
      });
    }
    editorReadyRef.current = isReady;
  }, [isReady, contentBaselines, loadedText, noteId]);

  // Applies a theme switch made while the note is open; the initial colours
  // already come from the bridge CSS above.
  useEffect(() => {
    if (!isReady) return;
    editor.injectCSS(buildEditorColorCss(semantic, isDark), "dark-mode");
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

  // No header title here: the title field below is the note's title, and the
  // header (title "", back label "Notes") is set once in app/_layout.tsx.
  return (
    <KeyboardAvoidingView
      testID="editor-keyboard-avoiding-view"
      style={styles.container}
      // Android runs edge-to-edge, so the window no longer shrinks for the
      // keyboard and the view has to make room itself, as the auth screens do.
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      // The view starts below the opaque header, but the keyboard's position is
      // reported in screen coordinates. Without the header height as the offset
      // the view stops that far short of the keyboard and the toolbar ends up
      // behind it.
      keyboardVerticalOffset={headerHeight}
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
        <NoteEditor
          editor={editor}
          accessory={<AttachmentPicker noteId={noteId} onAttachmentReady={handleAttachmentReady} />}
        />
      </View>
      {/* Keeps the attachment row clear of the home indicator / gesture bar. With
          the keyboard up the keyboard covers that area, so the toolbar sits
          directly on it instead. */}
      <View
        testID="editor-bottom-inset"
        style={[styles.bottomInset, { height: isKeyboardUp ? 0 : insets.bottom }]}
      />
    </KeyboardAvoidingView>
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
    bottomInset: {
      backgroundColor: semantic.bg,
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
