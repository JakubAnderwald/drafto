import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from "react-native";
import { useEditorBridge, TenTapStartKit } from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";

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
import { FindBar } from "@/components/editor/find-bar";
import {
  findSearchJS,
  findStepJS,
  findClearJS,
  parseFindResult,
  type FindResult,
} from "@/components/editor/find-engine";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { isCatastrophicEraseSave } from "@/components/notes/erase-tripwire";
import {
  classifyNoteContent,
  resolveImageUrlsOrFallback,
} from "@/components/notes/note-content-loader";

type SaveStatusKey = "saving" | "saved" | "error";

const saveStatusConfig: Record<SaveStatusKey, { label: string; variant: BadgeVariant }> = {
  saving: { label: "Saving", variant: "warning" },
  saved: { label: "Saved", variant: "success" },
  error: { label: "Error", variant: "error" },
};

// Autosave payloads carry the noteId of the note that was being edited when the
// save was queued. Looking up the record by id inside the save handler (rather
// than closing over the `note` prop) makes it impossible for a late-firing
// debounced save to land on the wrong row if the user has since switched notes.
type TitleSavePayload = { noteId: string; title: string };
type ContentSavePayload = { noteId: string; content: string };

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

// Bound on image-URL resolution so a never-settling signed-URL fetch can't hang
// a note load (and strand the loading overlay). On timeout, resolve to the
// unresolved doc — images degrade to placeholders; attachment:// is the
// canonical stored form, so persisting it back is non-destructive.
const RESOLVE_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Imperative signal from the native Find menu items (Cmd+F / Cmd+G / Cmd+Shift+G). */
export interface FindSignal {
  command: "open" | "next" | "prev";
  /** Incremented on each menu invocation so repeats re-trigger the panel. */
  nonce: number;
}

interface NoteEditorPanelProps {
  noteId: string | undefined;
  findSignal?: FindSignal;
}

export function NoteEditorPanel({ noteId, findSignal }: NoteEditorPanelProps) {
  const { note, loading } = useNote(noteId);
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [title, setTitle] = useState("");

  // noteIdRef tracks which note the panel is currently *displaying* (updated as
  // soon as a note switch is intended). loadedNoteIdRef tracks which note's
  // content is actually inside the WebView editor right now (set only after
  // setContent has completed). Autosave is gated on loadedNoteIdRef so that
  // onChange events emitted before a load finishes are ignored and cannot leak
  // the previous note's content into the newly-switched-to row.
  const noteIdRef = useRef<string | undefined>(undefined);
  const loadedNoteIdRef = useRef<string | null>(null);
  // Tracks the last-handled findSignal so the effect fires once per menu press.
  const lastFindNonceRef = useRef(0);

  const handleSaveTitle = useCallback(async (payload: TitleSavePayload) => {
    // Don't persist an empty/whitespace title over a real one (a transient clear,
    // or a flush firing mid-edit).
    if (!payload.title.trim()) return;
    const record = await database.get<Note>("notes").find(payload.noteId);
    await database.write(async () => {
      await record.update((n) => {
        n.title = payload.title;
      });
    });
  }, []);

  const handleSaveContent = useCallback(async (payload: ContentSavePayload) => {
    const record = await database.get<Note>("notes").find(payload.noteId);
    if (isCatastrophicEraseSave(record.content, payload.content)) {
      console.warn(
        "[note-editor] tripwire blocked catastrophic-erase save",
        `noteId=${payload.noteId}`,
        `existing=${record.content?.length ?? 0}B`,
        `incoming=${payload.content.length}B`,
      );
      return;
    }
    await database.write(async () => {
      await record.update((n) => {
        n.content = payload.content;
      });
    });
  }, []);

  const titleAutoSave = useAutoSave<TitleSavePayload>({ onSave: handleSaveTitle });
  const contentAutoSave = useAutoSave<ContentSavePayload>({ onSave: handleSaveContent });

  const titleAutoSaveRef = useRef(titleAutoSave);
  const contentAutoSaveRef = useRef(contentAutoSave);
  titleAutoSaveRef.current = titleAutoSave;
  contentAutoSaveRef.current = contentAutoSave;

  const [editorReady, setEditorReady] = useState(false);
  // Shown (as an overlay) from the moment a different note is selected until its
  // content is set into the editor — so the previous note's stale body is never
  // visible during the swap. The editor/WebView itself is never unmounted.
  const [contentLoading, setContentLoading] = useState(false);
  // Set when a note's content fails to load; drives an error overlay so a load
  // failure shows an error instead of revealing the previous note's stale body
  // under the new note's header (autosave stays gated via loadedNoteIdRef).
  const [loadFailed, setLoadFailed] = useState(false);

  // Find-in-note UI state. The WebView (via the injected engine) is the source of
  // truth for matches; findMatch just mirrors the counts it posts back.
  const [findVisible, setFindVisible] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatch, setFindMatch] = useState<FindResult>({ current: 0, total: 0 });

  const handleEditorChange = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Guard: only persist edits for the note whose content is actually loaded
    // into the editor. Spurious onChange emissions during note switches (or any
    // tentap internal transition) would otherwise read stale editor JSON and
    // save it to the wrong note — the exact incident that corrupted data in
    // prod on 2026-04-24.
    const loaded = loadedNoteIdRef.current;
    if (!loaded || loaded !== noteIdRef.current) return;
    editor
      .getJSON()
      .then((json: object) => {
        // Re-check after the async boundary; the user may have switched notes
        // while getJSON() was in flight.
        if (loadedNoteIdRef.current !== loaded || noteIdRef.current !== loaded) return;
        const blocknote = tiptapToBlocknote(json as TipTapDoc);
        // Rewrite any signed URLs back to attachment:// before persisting so
        // expiring tokens never reach the DB. Display-side resolution happens
        // on note load via resolveTipTapImageUrls.
        const migrated = migrateSignedUrlsToAttachmentUrls(blocknote);
        contentAutoSaveRef.current?.trigger({
          noteId: loaded,
          content: JSON.stringify(migrated),
        });
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

  // Gate content loads on tentap's real readiness signal instead of polling
  // editor.getJSON(). A resolved getJSON() only proves the WebView bridge can
  // round-trip a message — NOT that the ProseMirror view is mounted and able to
  // accept setContent. On macOS that gap left the very first setContent silently
  // dropped, so notes opened blank even though their content was present and
  // valid in the DB (issue #551). `isReady` flips true off the web editor's
  // onCreate state update, which is the first instant setContent is honoured.
  // (This is the same signal the library's own useBridgeState hook reads; we
  // subscribe directly and unsubscribe once ready to avoid re-rendering the
  // panel on every keystroke.)
  useEffect(() => {
    if (editorReady) return;
    if (editor.getEditorState().isReady) {
      setEditorReady(true);
      return;
    }
    return editor._subscribeToEditorStateUpdate((state) => {
      if (state.isReady) setEditorReady(true);
    });
  }, [editor, editorReady]);

  // Full find reset — clears the bar, query, counts, and WebView highlights.
  // Used on note switch / no-note (highlights point at the outgoing note's DOM)
  // and on explicit close.
  const resetFind = useCallback(() => {
    setFindVisible(false);
    setFindQuery("");
    setFindMatch({ current: 0, total: 0 });
    editorRef.current?.webviewRef.current?.injectJavaScript(findClearJS());
  }, []);

  // Sync local state when a different note is loaded.
  useEffect(() => {
    if (!editorReady) return;

    if (note && note.id !== noteIdRef.current) {
      // Flush pending autosaves BEFORE switching the noteId refs so any
      // still-in-flight save goes through with the previous note's payload
      // (which already carries that note's id, so it lands on the right row).
      titleAutoSaveRef.current?.flush();
      contentAutoSaveRef.current?.flush();

      resetFind(); // highlights point at the outgoing note's DOM

      noteIdRef.current = note.id;
      loadedNoteIdRef.current = null; // gate autosave until setContent completes
      setContentLoading(true); // overlay the editor until setContent() lands
      setLoadFailed(false);
      setTitle(note.title || "");

      const rawContent = note.content || "";
      let cancelled = false;
      const targetNoteId = note.id;

      const markLoaded = () => {
        if (cancelled) return;
        // Only flip the gate if the user hasn't switched notes again while we
        // were loading; otherwise another effect run is already handling the
        // newer note.
        if (noteIdRef.current === targetNoteId) {
          loadedNoteIdRef.current = targetNoteId;
          setContentLoading(false);
        }
      };

      (async () => {
        try {
          const load = classifyNoteContent(rawContent);
          if (load.kind === "empty") {
            editorRef.current?.setContent("");
            markLoaded();
            return;
          }
          if (load.kind === "html") {
            editorRef.current?.setContent(load.html);
            markLoaded();
            return;
          }
          const tiptapDoc = contentToTiptap(load.value);
          // Resolve image URLs defensively, bounded by a timeout so a
          // never-settling signed-URL fetch can't strand the loading overlay: a
          // resolution failure/timeout degrades images to placeholders rather
          // than blanking the whole (otherwise valid) note.
          const resolved = await withTimeout(
            resolveImageUrlsOrFallback(tiptapDoc, getSignedUrl),
            RESOLVE_TIMEOUT_MS,
            tiptapDoc,
          );
          if (cancelled || noteIdRef.current !== targetNoteId) return;
          editorRef.current?.setContent(resolved);
          markLoaded();
        } catch (err) {
          // Intentionally do NOT call editor.setContent("") or markLoaded()
          // here. Wiping the editor would only cosmetically clear the WebView;
          // calling markLoaded would open the autosave gate, allowing the
          // editor's empty bootstrap onChange to persist an empty BlockNote
          // and overwrite real DB content. The 2026-04-24 and 2026-04-27
          // incidents both took this exact path. Leaving the gate closed on
          // load failure means a stuck editor (the user can close+reopen),
          // never a destructively-persisted empty doc.
          console.warn(
            "[note-editor] content load failed; leaving autosave gated",
            `noteId=${targetNoteId}`,
            err,
          );
          // Swap the loading spinner for an error overlay (not the editor "as
          // is") so a load failure never reveals the previous note's body under
          // the new note's header. The autosave stays gated above.
          if (!cancelled && noteIdRef.current === targetNoteId) {
            setContentLoading(false);
            setLoadFailed(true);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    } else if (!note) {
      titleAutoSaveRef.current?.flush();
      contentAutoSaveRef.current?.flush();
      resetFind();
      noteIdRef.current = undefined;
      loadedNoteIdRef.current = null;
      setContentLoading(false);
      setLoadFailed(false);
      setTitle("");
      try {
        editorRef.current?.setContent("");
      } catch {
        // Editor not ready — safe to ignore
      }
    }
    // `editor` is intentionally NOT a dependency here. useEditorBridge returns a
    // NEW object every render, so depending on it re-ran this effect on every
    // render — cancelling an in-flight async content resolve (via the cleanup's
    // `cancelled = true`) and stranding the loading overlay for notes whose
    // resolution didn't finish within a single microtask (attachment notes). The
    // live editor is read through editorRef.current instead.
  }, [note?.id, editorReady, resetFind]);

  const handleAttachmentReady = useCallback(
    async (attachment: Attachment) => {
      // Only append if the editor is actually loaded with the right note.
      const active = loadedNoteIdRef.current;
      if (!active || active !== noteIdRef.current) return;
      try {
        const node = await buildInsertNode(attachment);
        const currentJson = (await editor.getJSON()) as TipTapDoc;
        if (loadedNoteIdRef.current !== active || noteIdRef.current !== active) return;
        const appended: TipTapDoc = {
          type: "doc",
          content: [...(currentJson.content ?? []), node],
        };
        editor.setContent(appended);
        // setContent doesn't reliably trigger onChange in tentap. Persist
        // directly, addressing the note by id rather than via the prop closure
        // so a mid-flight note switch can't reroute the write. Supersede any
        // pending pre-attachment autosave first — otherwise its 800 ms debounce
        // would fire later with stale content and strand the inline reference.
        const blocks = tiptapToBlocknote(appended);
        const migrated = migrateSignedUrlsToAttachmentUrls(blocks);
        const serialized = JSON.stringify(migrated);
        const record = await database.get<Note>("notes").find(active);
        await database.write(async () => {
          await record.update((n) => {
            n.content = serialized;
          });
        });
        // Cancel after the authoritative write completes — `setContent(appended)`
        // may have synchronously fired tentap's onChange, which then async-resolves
        // a fresh `trigger()` past the cancel. Clearing once the explicit write
        // has landed guarantees no redundant debounced rewrite remains scheduled.
        contentAutoSaveRef.current?.cancel();
      } catch (err) {
        console.warn("Failed to insert attachment inline:", err);
      }
    },
    [editor],
  );

  // Flush pending autosaves on unmount.
  useEffect(() => {
    return () => {
      titleAutoSaveRef.current?.flush();
      contentAutoSaveRef.current?.flush();
    };
  }, []);

  const handleTitleChange = useCallback((text: string) => {
    setTitle(text);
    const active = loadedNoteIdRef.current;
    if (!active || active !== noteIdRef.current) return;
    titleAutoSaveRef.current?.trigger({ noteId: active, title: text });
  }, []);

  // --- Find in note ---------------------------------------------------------
  // Cmd+F is captured natively (DraftoMenuManager) and forwarded here as a
  // findSignal. Highlight/scroll is driven by injecting the find engine into the
  // tentap WebView; match counts come back via handleEditorMessage. Nothing here
  // mutates note content — the CSS Custom Highlight overlay leaves the DOM alone.
  const injectFind = useCallback((js: string) => {
    editorRef.current?.webviewRef.current?.injectJavaScript(js);
  }, []);

  const handleFindChange = useCallback(
    (query: string) => {
      setFindQuery(query);
      injectFind(findSearchJS(query));
    },
    [injectFind],
  );

  const handleFindNext = useCallback(() => {
    injectFind(findStepJS("next"));
  }, [injectFind]);

  const handleFindPrev = useCallback(() => {
    injectFind(findStepJS("prev"));
  }, [injectFind]);

  const handleFindClose = useCallback(() => {
    resetFind();
  }, [resetFind]);

  const handleEditorMessage = useCallback((event: WebViewMessageEvent) => {
    const result = parseFindResult(event);
    if (result) setFindMatch(result);
  }, []);

  // React to native Find menu commands. Every command opens the bar (only when a
  // note is loaded); next/prev also step. Refocus on repeated Cmd+F is handled by
  // FindBar via focusSignal (the nonce).
  useEffect(() => {
    if (!findSignal || findSignal.nonce === lastFindNonceRef.current) return;
    lastFindNonceRef.current = findSignal.nonce;
    if (!noteIdRef.current) return; // no note selected — nothing to find
    setFindVisible(true);
    if (findSignal.command === "next") handleFindNext();
    else if (findSignal.command === "prev") handleFindPrev();
  }, [findSignal, handleFindNext, handleFindPrev]);

  const saveStatusKey: SaveStatusKey | null =
    titleAutoSave.status === "saving" || contentAutoSave.status === "saving"
      ? "saving"
      : titleAutoSave.status === "error" || contentAutoSave.status === "error"
        ? "error"
        : titleAutoSave.status === "saved" || contentAutoSave.status === "saved"
          ? "saved"
          : null;
  const statusConfig = saveStatusKey ? saveStatusConfig[saveStatusKey] : null;

  // The editor (and its tentap WebView) is mounted ONCE and never unmounted.
  // On macOS (New Arch / Fabric + react-native-webview) an unmounted WKWebView is
  // recycled rather than destroyed, and remounting it strands the editor on the
  // previously-loaded note's stale DOM — the note-switch bug. So note content is
  // swapped via editor.setContent() on the live WebView (the load effect), and the
  // select / loading / not-found states render as OVERLAYS on top of the editor
  // rather than early-returns that would unmount it.
  return (
    <View style={styles.container}>
      {note && (
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
      )}

      <View style={styles.editorContainer}>
        <NoteEditor editor={editor} onMessage={handleEditorMessage} />
        {findVisible && note && (
          <FindBar
            query={findQuery}
            match={findMatch}
            onChangeQuery={handleFindChange}
            onNext={handleFindNext}
            onPrev={handleFindPrev}
            onClose={handleFindClose}
            focusSignal={findSignal?.nonce ?? 0}
          />
        )}
      </View>

      {note && <AttachmentPicker noteId={note.id} onAttachmentReady={handleAttachmentReady} />}

      {!noteId && (
        <View style={styles.overlay}>
          <EmptyState
            icon="✏️"
            title="Select a note"
            subtitle="Choose a note from the list to start editing"
          />
        </View>
      )}

      {noteId && (loading || !editorReady || contentLoading) && (
        <View style={styles.overlay}>
          <ActivityIndicator size="small" color={colors.primary[600]} />
        </View>
      )}

      {noteId && !loading && !note && (
        <View style={styles.overlay}>
          <EmptyState icon="🔍" title="Note not found" subtitle="This note may have been deleted" />
        </View>
      )}

      {noteId && !loading && note && loadFailed && (
        <View style={styles.overlay}>
          <EmptyState
            icon="⚠️"
            title="Couldn't load this note"
            subtitle="Switch away and back to retry"
          />
        </View>
      )}
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
    // Covers the always-mounted editor for the select / loading / not-found
    // states (the editor is never unmounted — see the render note).
    overlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: semantic.bg,
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
