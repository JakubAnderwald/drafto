import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from "react-native";
import { useEditorBridge, TenTapStartKit } from "@10play/tentap-editor";

import { useNote } from "@/hooks/use-note";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useTheme } from "@/providers/theme-provider";
import { database, Note, type Attachment } from "@/db";
import {
  contentToTiptap,
  formatRelativeTime,
  tiptapToBlocknote,
  toAttachmentUrl,
  resolveTipTapImageUrls,
  migrateSignedUrlsToAttachmentUrls,
} from "@drafto/shared";
import type { TipTapDoc, TipTapNode } from "@drafto/shared";
import { getSignedUrl } from "@/lib/data";
import { colors, fontSizes, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { CalendarIcon } from "@/components/ui/icons/calendar-icon";
import { ClockIcon } from "@/components/ui/icons/clock-icon";
import { NoteEditor } from "@/components/editor/note-editor";
import { AttachmentPicker } from "@/components/editor/attachment-picker";

const FONT_SANS = "Geist";

const saveStatusConfig: Record<string, { label: string; variant: BadgeVariant }> = {
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

interface NoteEditorPanelProps {
  noteId: string | undefined;
}

export function NoteEditorPanel({ noteId }: NoteEditorPanelProps) {
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

  const handleSaveTitle = useCallback(async (payload: TitleSavePayload) => {
    const record = await database.get<Note>("notes").find(payload.noteId);
    await database.write(async () => {
      await record.update((n) => {
        n.title = payload.title;
      });
    });
  }, []);

  const handleSaveContent = useCallback(async (payload: ContentSavePayload) => {
    const record = await database.get<Note>("notes").find(payload.noteId);
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

  useEffect(() => {
    if (editorReady) return;
    const interval = setInterval(() => {
      try {
        editor
          .getJSON()
          .then(() => {
            setEditorReady(true);
            clearInterval(interval);
          })
          .catch(() => {});
      } catch {}
    }, 200);
    return () => clearInterval(interval);
  }, [editor, editorReady]);

  // Sync local state when a different note is loaded.
  useEffect(() => {
    if (!editorReady) return;

    if (note && note.id !== noteIdRef.current) {
      // Flush pending autosaves BEFORE switching the noteId refs so any
      // still-in-flight save goes through with the previous note's payload
      // (which already carries that note's id, so it lands on the right row).
      titleAutoSaveRef.current?.flush();
      contentAutoSaveRef.current?.flush();

      noteIdRef.current = note.id;
      loadedNoteIdRef.current = null; // gate autosave until setContent completes
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
        }
      };

      (async () => {
        try {
          if (!rawContent) {
            editor.setContent("");
            markLoaded();
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
            markLoaded();
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
            markLoaded();
            return;
          }
          const tiptapDoc = contentToTiptap(parsed);
          const resolved = await resolveTipTapImageUrls(tiptapDoc, getSignedUrl);
          if (cancelled || noteIdRef.current !== targetNoteId) return;
          editor.setContent(resolved);
          markLoaded();
        } catch (err) {
          console.warn("Failed to set editor content:", err);
          if (!cancelled) {
            editor.setContent("");
            markLoaded();
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    } else if (!note) {
      titleAutoSaveRef.current?.flush();
      contentAutoSaveRef.current?.flush();
      noteIdRef.current = undefined;
      loadedNoteIdRef.current = null;
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

  const saveStatusKey =
    titleAutoSave.status === "saving" || contentAutoSave.status === "saving"
      ? "saving"
      : titleAutoSave.status === "error" || contentAutoSave.status === "error"
        ? "error"
        : titleAutoSave.status === "saved" || contentAutoSave.status === "saved"
          ? "saved"
          : null;
  const statusConfig = saveStatusKey ? saveStatusConfig[saveStatusKey] : null;

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

        {note && (
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
        )}
      </View>

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
      fontFamily: FONT_SANS,
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
      fontFamily: FONT_SANS,
    },
    editorContainer: {
      flex: 1,
      minHeight: 0,
    },
  });
