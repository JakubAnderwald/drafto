"use client";

import { use, useCallback, useEffect, useState } from "react";
import { NoteEditor } from "@/components/editor/note-editor";
import { NoteSyncBanner } from "@/components/notes/note-sync-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useNoteSync, type NoteSnapshot, type NoteSyncEvent } from "@/hooks/use-note-sync";
import { handleAuthError } from "@/lib/handle-auth-error";
import { maxTimestamp } from "@/lib/timestamps";
import type { Block } from "@blocknote/core";
import type { BadgeVariant } from "@/components/ui/badge";
import type { NoteListPatch } from "@/lib/note-patch";
import {
  MAX_TITLE_LENGTH,
  formatRelativeTime,
  normalizeBlocks,
  type BlockNoteBlock,
} from "@drafto/shared";

interface NoteEditorPanelProps {
  noteId: string;
  refreshTrigger?: number;
  onNoteUpdated?: (patch: NoteListPatch) => void;
  /** The note is gone (trashed or deleted elsewhere) and the user dismissed it. */
  onNoteClosed?: (noteId: string) => void;
}

/** How the open note ceased to exist somewhere else, if it did. */
type NoteLifecycle = "trashed" | "deleted" | null;

const noteCache = new Map<string, Promise<NoteSnapshot | null>>();

function fetchNote(noteId: string, cacheKey: string): Promise<NoteSnapshot | null> {
  const cached = noteCache.get(cacheKey);
  if (cached) return cached;

  // Evict stale entries for the same note to keep cache bounded
  for (const key of noteCache.keys()) {
    if (key.startsWith(`${noteId}-`)) {
      noteCache.delete(key);
    }
  }

  const promise = fetch(`/api/notes/${noteId}`).then((res) => {
    if (handleAuthError(res)) return null;
    return res.ok ? res.json() : null;
  });

  noteCache.set(cacheKey, promise);
  return promise;
}

const saveStatusConfig: Record<string, { label: string; variant: BadgeVariant }> = {
  saving: { label: "Saving", variant: "warning" },
  saved: { label: "Saved", variant: "success" },
  error: { label: "Error", variant: "error" },
};

function CalendarIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M5 1.5v2M11 1.5v2M2 7h12" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

export function NoteEditorPanel({
  noteId,
  refreshTrigger = 0,
  onNoteUpdated,
  onNoteClosed,
}: NoteEditorPanelProps) {
  const cacheKey = `${noteId}-${refreshTrigger}`;
  // Initial load only. External refreshes deliberately do NOT go through this cache
  // key: re-suspending would commit the Suspense fallback, unmounting BlockNote and
  // discarding the caret, selection and scroll position mid-session.
  const loaded = use(fetchNote(noteId, cacheKey));

  const [applied, setApplied] = useState(loaded);
  const [prevLoaded, setPrevLoaded] = useState(loaded);
  const [title, setTitle] = useState(loaded?.title ?? "");
  // Bumped whenever content is replaced from the server; part of the editor's `key`,
  // because `useCreateBlockNote` reads `initialContent` once per instance.
  const [contentEpoch, setContentEpoch] = useState(0);
  const [conflict, setConflict] = useState<NoteSnapshot | null>(null);
  const [lifecycle, setLifecycle] = useState<NoteLifecycle>(loaded?.is_trashed ? "trashed" : null);

  const { saveStatus, debouncedSave, lastSavedAt, hasPendingChanges, cancelPendingSave } =
    useAutoSave({ noteId });

  // Adopt a fresh server load (the parent bumped refreshTrigger). Render-phase state
  // adjustment: only this component's own state, and it converges in one extra pass.
  if (prevLoaded !== loaded) {
    setPrevLoaded(loaded);
    setApplied(loaded);
    setTitle(loaded?.title ?? "");
    setContentEpoch((n) => n + 1);
    setConflict(null);
    setLifecycle(loaded?.is_trashed ? "trashed" : null);
  }

  // "error" counts as dirty: the edit is still only in the browser.
  const isDirty = hasPendingChanges || saveStatus === "saving" || saveStatus === "error";
  const syncedAt = maxTimestamp(applied?.updated_at ?? null, lastSavedAt);

  const applyRemote = useCallback(
    (next: NoteSnapshot) => {
      setApplied(next);
      setTitle(next.title);
      setConflict(null);
      setContentEpoch((n) => n + 1);
      onNoteUpdated?.({ noteId, updatedAt: next.updated_at, title: next.title });
    },
    [noteId, onNoteUpdated],
  );

  // Single reconciliation path for every signal the sync hook multiplexes. Runs from
  // a subscription callback, so `isDirty` is read at the moment the change lands.
  const handleExternalChange = useCallback(
    (event: NoteSyncEvent) => {
      if (event.kind === "deleted") {
        // Nothing left to write to — drop queued edits so they don't 404 the note
        // into a spurious "Error" badge.
        cancelPendingSave();
        setLifecycle("deleted");
        onNoteUpdated?.({ noteId, removed: true });
        return;
      }

      if (event.kind === "trashed") {
        // Deliberately keep the editor mounted and autosave running: PATCH has no
        // is_trashed guard, so an in-flight save still lands in the trashed row and
        // is recoverable by restoring it. Cancelling here would be the data loss.
        setLifecycle("trashed");
        onNoteUpdated?.({ noteId, removed: true });
        return;
      }

      if (isDirty) {
        // Never overwrite unsaved local work without telling the user first. The
        // hook has already advanced its watermark, so this exact change stops
        // nagging while a genuinely newer one still surfaces.
        setConflict(event.note);
        return;
      }

      applyRemote(event.note);
    },
    [isDirty, applyRemote, cancelPendingSave, noteId, onNoteUpdated],
  );

  useNoteSync({ noteId, syncedAt, onExternalChange: handleExternalChange });

  useEffect(() => {
    if (lastSavedAt) {
      onNoteUpdated?.({ noteId, updatedAt: lastSavedAt });
    }
  }, [lastSavedAt, noteId, onNoteUpdated]);

  const handleReloadFromRemote = useCallback(() => {
    if (!conflict) return;
    // Cancel first: a queued PATCH landing after the reload would re-clobber the
    // content we just pulled in.
    cancelPendingSave();
    applyRemote(conflict);
  }, [conflict, cancelPendingSave, applyRemote]);

  const note = applied;

  if (!note) {
    return (
      <div className="text-fg-subtle flex flex-1 items-center justify-center">Note not found</div>
    );
  }

  function handleTitleChange(newTitle: string) {
    setTitle(newTitle);
    debouncedSave({ title: newTitle });
  }

  function handleContentChange(content: Block[]) {
    // No first-change guard here on purpose. A remount does not emit a change, and a
    // guard would swallow the user's first real keystroke after an external apply.
    // A redundant save would at worst cost one idempotent PATCH, which the sync
    // watermark then suppresses.
    debouncedSave({ content });
  }

  const statusConfig = saveStatusConfig[saveStatus];
  const modifiedAt = syncedAt ?? note.updated_at;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Title + timestamps + save indicator */}
      <div className="bg-bg-subtle shrink-0 px-6 py-4">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            maxLength={MAX_TITLE_LENGTH}
            className="text-fg placeholder:text-fg-subtle focus:border-border-strong focus:ring-ring min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-xl font-bold transition-colors duration-[var(--transition-fast)] outline-none focus:ring-1"
            placeholder="Untitled"
            aria-label="Note title"
          />
          {statusConfig && (
            <Badge
              variant={statusConfig.variant}
              data-testid="save-status-badge"
              role={statusConfig.variant === "error" ? "alert" : "status"}
              aria-live={statusConfig.variant === "error" ? "assertive" : "polite"}
              aria-atomic="true"
            >
              {statusConfig.label}
            </Badge>
          )}
        </div>
        <div className="text-fg-subtle mt-2 flex gap-4 text-xs">
          <span className="inline-flex items-center gap-1">
            <CalendarIcon />
            Created {formatRelativeTime(note.created_at)}
          </span>
          <span className="inline-flex items-center gap-1">
            <ClockIcon />
            Modified {formatRelativeTime(modifiedAt)}
          </span>
        </div>
      </div>

      {lifecycle === "deleted" && (
        <NoteSyncBanner tone="error" message="This note was permanently deleted on another device.">
          <Button size="sm" variant="secondary" onClick={() => onNoteClosed?.(noteId)}>
            Close
          </Button>
        </NoteSyncBanner>
      )}

      {lifecycle === "trashed" && (
        <NoteSyncBanner message="This note was moved to Trash on another device. Your edits are still being saved to it — restore it from Trash to keep working on it.">
          <Button size="sm" variant="secondary" onClick={() => onNoteClosed?.(noteId)}>
            Close
          </Button>
        </NoteSyncBanner>
      )}

      {conflict && lifecycle === null && (
        <NoteSyncBanner message="This note was changed on another device. Your unsaved edits are still here.">
          <Button size="sm" variant="secondary" onClick={handleReloadFromRemote}>
            Discard mine
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
            Keep mine
          </Button>
        </NoteSyncBanner>
      )}

      {/* Editor */}
      {lifecycle !== "deleted" && (
        <NoteEditor
          key={`${noteId}-${contentEpoch}`}
          noteId={noteId}
          initialContent={
            note.content
              ? (normalizeBlocks(note.content as BlockNoteBlock[]) as unknown as Block[])
              : undefined
          }
          onChange={handleContentChange}
        />
      )}
    </div>
  );
}
