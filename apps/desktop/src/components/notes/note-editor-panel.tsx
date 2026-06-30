import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from "react-native";
import { useEditorBridge, useBridgeState, TenTapStartKit } from "@10play/tentap-editor";

import { useNote } from "@/hooks/use-note";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useTheme } from "@/providers/theme-provider";
import { database, Note, type Attachment } from "@/db";
import {
  contentToTiptap,
  formatRelativeTime,
  tiptapToBlocknote,
  toAttachmentUrl,
  migrateSignedUrlsToAttachmentUrls,
} from "@drafto/shared";
import type { TipTapDoc, TipTapNode } from "@drafto/shared";
import { getSignedUrl } from "@/lib/data";
import { colors, fontFamily, fontSizes, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { CalendarIcon } from "@/components/ui/icons/calendar-icon";
import { ClockIcon } from "@/components/ui/icons/clock-icon";
import { NoteEditor } from "@/components/editor/note-editor";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { isCatastrophicEraseSave } from "@/components/notes/erase-tripwire";
import {
  classifyNoteContent,
  hasAttachmentUrls,
  resolveImageUrlsOrFallback,
} from "@/components/notes/note-content-loader";

type SaveStatusKey = "saving" | "saved" | "error";

const saveStatusConfig: Record<SaveStatusKey, { label: string; variant: BadgeVariant }> = {
  saving: { label: "Saving", variant: "warning" },
  saved: { label: "Saved", variant: "success" },
  error: { label: "Error", variant: "error" },
};

// Bound on the editor.getJSON() WebView round-trip. If the WebView is torn down
// (note switch) while a getJSON is in flight, AsyncMessages never resolves and
// never rejects — wrapping it lets the listener be released instead of leaking.
const GETJSON_TIMEOUT_MS = 4000;
// Bound on image-URL resolution so a never-settling signed-URL fetch can't pin
// the note on a spinner forever; on timeout we render the unresolved doc.
const RESOLVE_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Serialize the editor's TipTap JSON into the BlockNote string stored in the DB,
// rewriting signed URLs back to attachment:// so expiring tokens never persist.
function serializeEditorContent(json: object): string {
  return JSON.stringify(migrateSignedUrlsToAttachmentUrls(tiptapToBlocknote(json as TipTapDoc)));
}

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

// tentap accepts a TipTap doc OR an HTML string as `initialContent`.
type InitialContent = TipTapDoc | string;

// Resolve a note's stored content into the value handed to useEditorBridge as
// `initialContent`. Mirrors the mobile editor: the content is computed BEFORE
// the editor's WebView mounts, so tentap hydrates with it directly and there is
// never an imperative setContent racing an un-ready WebView — the failure mode
// behind issue #551 (note opens blank) and its note-switch variant (switching
// notes kept showing the previous note). Attachment:// URLs (images, files,
// inline links) resolve to signed URLs with a defensive fallback: a resolution
// failure (or timeout) degrades them to placeholders rather than blanking the
// note. `attachment://` is the canonical stored form, so persisting an
// unresolved doc back is non-destructive.
function useResolvedInitialContent(rawContent: string): {
  content: InitialContent;
  resolving: boolean;
} {
  const classified = useMemo(() => classifyNoteContent(rawContent), [rawContent]);
  const initial = useMemo<InitialContent>(() => {
    if (classified.kind === "empty") return "";
    if (classified.kind === "html") return classified.html;
    return contentToTiptap(classified.value);
  }, [classified]);
  const needsResolving = useMemo(
    () => typeof initial !== "string" && hasAttachmentUrls(initial.content ?? []),
    [initial],
  );

  const [content, setContent] = useState<InitialContent>(initial);
  const [resolving, setResolving] = useState(needsResolving);

  useEffect(() => {
    if (!needsResolving || typeof initial === "string") return;
    let settled = false;
    const finish = (resolved: InitialContent) => {
      if (settled) return;
      settled = true;
      setContent(resolved);
      setResolving(false);
    };
    withTimeout(
      resolveImageUrlsOrFallback(initial, getSignedUrl),
      RESOLVE_TIMEOUT_MS,
      "url resolve",
    )
      .then(finish)
      .catch(() => finish(initial)); // timeout / failure → render the unresolved doc
    return () => {
      settled = true;
    };
  }, [initial, needsResolving]);

  return { content, resolving };
}

interface NoteEditorPanelProps {
  noteId: string | undefined;
}

// Outer shell: resolves the selected note, then mounts a fresh editor per note
// via `key={note.id}` on LoadedNoteEditor. Keying the editor on the note id is
// what makes switching notes reliable — each note gets its own editor instance,
// created with its own content as `initialContent`, instead of one long-lived
// editor that must be imperatively re-pointed at each note (the setContent model
// that silently dropped content on macOS's WKWebView).
export function NoteEditorPanel({ noteId }: NoteEditorPanelProps) {
  const { note, loading } = useNote(noteId);
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

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

  if (!note) {
    return (
      <View style={styles.container}>
        <EmptyState icon="🔍" title="Note not found" subtitle="This note may have been deleted" />
      </View>
    );
  }

  return <LoadedNoteEditor key={note.id} note={note} />;
}

interface LoadedNoteEditorProps {
  note: Note;
}

function LoadedNoteEditor({ note }: LoadedNoteEditorProps) {
  const noteId = note.id;
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  // Capture the note's title + content ONCE per mount. `key={note.id}` on this
  // component guarantees a remount whenever the selected note changes, so "once
  // per mount" == "once per note". Live record re-emissions (the note prop
  // updates on every autosave) therefore can't re-resolve content or reset the
  // editor; only the metadata below reads the live `note` prop.
  const [initialContent] = useState(() => note.content || "");
  const [title, setTitle] = useState(() => note.title || "");
  const { content: resolvedContent, resolving } = useResolvedInitialContent(initialContent);

  // editorReadyRef gates autosave on tentap's real readiness signal. onChange
  // emissions during WebView bootstrap (before the ProseMirror view is mounted)
  // must not persist — an empty/partial editor state could otherwise overwrite
  // real DB content (the 2026-04-24 / 2026-04-27 incident class). Because the
  // editor is created WITH this note's content as initialContent, the first
  // honoured state already holds the real content, so a ready-state onChange
  // re-saves the same content rather than blanking it.
  const editorReadyRef = useRef(false);
  // True while this per-note editor instance is mounted. The content save reads
  // the editor LIVE while mounted (so a save always reflects the current state);
  // once unmounted (note switch / close) the WebView is gone, so the flush falls
  // back to latestContentRef instead of a getJSON that would never resolve.
  const mountedRef = useRef(true);

  // Dead-WebView fallback: the latest serialized content captured from a RESOLVED
  // getJSON, kept warm on every edit. captureGenRef stamps each capture so a
  // slow/older getJSON resolving after a newer edit (or an attachment insert)
  // can't move this ref backwards. null until the first capture.
  const latestContentRef = useRef<string | null>(null);
  const captureGenRef = useRef(0);

  // Declared before the save handlers so handleSaveContent can read the editor.
  const editorRef = useRef<ReturnType<typeof useEditorBridge> | null>(null);

  const handleSaveTitle = useCallback(
    async (newTitle: string) => {
      // Don't let a transient clear (select-all+delete, or a flush firing
      // mid-edit) overwrite a real title with empty/whitespace.
      if (!newTitle.trim()) return;
      const record = await database.get<Note>("notes").find(noteId);
      await database.write(async () => {
        await record.update((n) => {
          n.title = newTitle;
        });
      });
    },
    [noteId],
  );

  const handleSaveContent = useCallback(async () => {
    let content: string | null;
    const editor = editorRef.current;
    if (editor && mountedRef.current) {
      // Mounted: read the editor LIVE so the save reflects the CURRENT state,
      // immune to capture timing and stale in-flight getJSONs.
      try {
        const serialized = serializeEditorContent(
          await withTimeout(editor.getJSON(), GETJSON_TIMEOUT_MS, "getJSON"),
        );
        // This live read is the freshest content — supersede older in-flight
        // onChange captures (bump AFTER a successful read so a failed read does
        // NOT invalidate the in-flight capture for this same edit) and record it
        // as the dead-WebView fallback.
        captureGenRef.current++;
        latestContentRef.current = serialized;
        content = serialized;
      } catch {
        // Live read failed (e.g. WebView mid-teardown) — fall back to whatever
        // the latest still-valid capture has left in latestContentRef.
        content = latestContentRef.current;
      }
    } else {
      // Unmounted (flush during note switch / close): the WebView is gone, so a
      // live getJSON would never resolve — persist the last captured snapshot.
      content = latestContentRef.current;
    }
    if (content === null) return; // nothing captured yet
    const record = await database.get<Note>("notes").find(noteId);
    if (record.content === content) return; // already persisted — skip redundant write
    // Tripwire: never let a save erase a non-trivial note down to (near) empty.
    if (isCatastrophicEraseSave(record.content, content)) {
      console.warn(
        "[note-editor] tripwire blocked catastrophic-erase save",
        `noteId=${noteId}`,
        `existing=${record.content?.length ?? 0}B`,
        `incoming=${content.length}B`,
      );
      return;
    }
    await database.write(async () => {
      await record.update((n) => {
        n.content = content;
      });
    });
  }, [noteId]);

  const titleAutoSave = useAutoSave<string>({ onSave: handleSaveTitle });
  const contentAutoSave = useAutoSave<void>({ onSave: handleSaveContent });

  const titleAutoSaveRef = useRef(titleAutoSave);
  const contentAutoSaveRef = useRef(contentAutoSave);
  titleAutoSaveRef.current = titleAutoSave;
  contentAutoSaveRef.current = contentAutoSave;

  const handleEditorChange = useCallback(() => {
    // Gate on readiness so the editor's bootstrap onChange can't persist a
    // partial state before the content has hydrated.
    if (!editorReadyRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    // Arm the debounce synchronously so a pending save always exists after an
    // edit — the unmount flush relies on it. The save reads the editor live, so
    // it is NOT gated on the capture below; this only keeps the dead-WebView
    // fallback warm, generation-guarded so a slow/older getJSON can't move it
    // backwards past a newer edit or an attachment insert.
    contentAutoSaveRef.current?.trigger();
    const gen = ++captureGenRef.current;
    withTimeout(editor.getJSON(), GETJSON_TIMEOUT_MS, "getJSON")
      .then((json) => {
        if (gen === captureGenRef.current) latestContentRef.current = serializeEditorContent(json);
      })
      .catch((err: unknown) => {
        console.warn("Editor getJSON failed:", err);
      });
  }, []);

  // Pass initialContent so tentap hydrates the WebView with the note's content
  // when it first initialises — no setContent race.
  const editor = useEditorBridge({
    autofocus: false,
    avoidIosKeyboard: false,
    bridgeExtensions: TenTapStartKit,
    initialContent: resolvedContent,
    onChange: handleEditorChange,
  });
  editorRef.current = editor;

  const { isReady } = useBridgeState(editor);
  useEffect(() => {
    editorReadyRef.current = isReady;
  }, [isReady]);

  // Flush pending autosaves on unmount (note switch or panel close) so the last
  // edits land. The content save reads latestContentRef synchronously, so this
  // persists the latest content captured before the switch without needing the
  // (now tearing-down) editor; the save is keyed to this note via noteId.
  // Mark unmounted in a LAYOUT-effect cleanup so it runs BEFORE passive-effect
  // cleanups — including useAutoSave's own internal unmount flush (it registers
  // `useEffect(() => flush)`). That ordering guarantees the flushed content save
  // takes the latestContentRef fallback path instead of calling getJSON on the
  // tearing-down WebView (which would hang until the timeout). The hook's own
  // unmount flush persists both pending saves, so no explicit flush is needed.
  useLayoutEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleTitleChange = useCallback((text: string) => {
    setTitle(text);
    titleAutoSaveRef.current?.trigger(text);
  }, []);

  const handleAttachmentReady = useCallback(
    async (attachment: Attachment) => {
      const editor = editorRef.current;
      if (!editor || !editorReadyRef.current) return;
      try {
        const node = await buildInsertNode(attachment);
        const currentJson = (await editor.getJSON()) as TipTapDoc;
        const appended: TipTapDoc = {
          type: "doc",
          content: [...(currentJson.content ?? []), node],
        };
        editor.setContent(appended);
        // setContent doesn't reliably trigger onChange in tentap. Persist
        // directly, addressing the note by id. Supersede any pending
        // pre-attachment autosave first — otherwise its debounce would fire
        // later with stale content and strand the inline reference.
        const blocks = tiptapToBlocknote(appended);
        const migrated = migrateSignedUrlsToAttachmentUrls(blocks);
        const serialized = JSON.stringify(migrated);
        // Supersede any in-flight pre-attachment getJSON capture (bump the
        // generation) so it can't resolve later and regress latestContentRef back
        // to pre-attachment content, then set the fallback baseline to the
        // appended content so a later flush doesn't overwrite this write.
        captureGenRef.current++;
        latestContentRef.current = serialized;
        const record = await database.get<Note>("notes").find(noteId);
        await database.write(async () => {
          await record.update((n) => {
            n.content = serialized;
          });
        });
        // Cancel after the authoritative write lands — `setContent(appended)`
        // may have synchronously armed a debounce via onChange.
        contentAutoSaveRef.current?.cancel();
      } catch (err) {
        console.warn("Failed to insert attachment inline:", err);
      }
    },
    [noteId],
  );

  const saveStatusKey: SaveStatusKey | null =
    titleAutoSave.status === "saving" || contentAutoSave.status === "saving"
      ? "saving"
      : titleAutoSave.status === "error" || contentAutoSave.status === "error"
        ? "error"
        : titleAutoSave.status === "saved" || contentAutoSave.status === "saved"
          ? "saved"
          : null;
  const statusConfig = saveStatusKey ? saveStatusConfig[saveStatusKey] : null;

  // Hold the editor surface back until image URLs have resolved so tentap
  // hydrates with the fully-resolved content in a single shot.
  if (resolving) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="small" color={colors.primary[600]} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <TextInput
            style={styles.titleInput}
            value={title}
            onChangeText={handleTitleChange}
            placeholder="Untitled"
            placeholderTextColor={semantic.fgSubtle}
          />
          {statusConfig && <Badge variant={statusConfig.variant} label={statusConfig.label} />}
        </View>

        <View style={styles.metadataRow}>
          <View style={styles.metadataItem}>
            <CalendarIcon size={14} color={semantic.fgSubtle} />
            <Text style={styles.metadataText}>Created {formatRelativeTime(note.createdAt)}</Text>
          </View>
          <View style={styles.metadataItem}>
            <ClockIcon size={14} color={semantic.fgSubtle} />
            <Text style={styles.metadataText}>Modified {formatRelativeTime(note.updatedAt)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.editorContainer}>
        <NoteEditor editor={editor} />
      </View>

      <AttachmentPicker noteId={noteId} onAttachmentReady={handleAttachmentReady} />
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
      backgroundColor: semantic.bgSubtle,
      paddingHorizontal: spacing["2xl"],
      paddingVertical: spacing.lg,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
    },
    titleInput: {
      flex: 1,
      fontSize: fontSizes["3xl"],
      fontWeight: "700",
      color: semantic.fg,
      fontFamily: fontFamily.sans,
      padding: 0,
    },
    metadataRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.lg,
      marginTop: spacing.sm,
    },
    metadataItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
    },
    metadataText: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      fontFamily: fontFamily.sans,
    },
    editorContainer: {
      flex: 1,
      minHeight: 0,
    },
  });
