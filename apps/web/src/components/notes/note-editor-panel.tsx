"use client";

import { use, useState } from "react";
import { NoteEditor } from "@/components/editor/note-editor";
import { Badge } from "@/components/ui/badge";
import { useAutoSave } from "@/hooks/use-auto-save";
import { handleAuthError } from "@/lib/handle-auth-error";
import { formatRelativeTime } from "@/lib/format-utils";
import type { Block } from "@blocknote/core";
import type { BadgeVariant } from "@/components/ui/badge";
import { MAX_TITLE_LENGTH } from "@drafto/shared";

interface NoteEditorPanelProps {
  noteId: string;
  refreshTrigger?: number;
}

interface NoteData {
  id: string;
  title: string;
  content: Block[] | null;
  created_at: string;
  updated_at: string;
}

const noteCache = new Map<string, Promise<NoteData | null>>();

function fetchNote(noteId: string, cacheKey: string): Promise<NoteData | null> {
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

export function NoteEditorPanel({ noteId, refreshTrigger = 0 }: NoteEditorPanelProps) {
  const cacheKey = `${noteId}-${refreshTrigger}`;
  const note = use(fetchNote(noteId, cacheKey));
  const [title, setTitle] = useState(note?.title ?? "");
  const { saveStatus, debouncedSave } = useAutoSave({ noteId });

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
    debouncedSave({ content });
  }

  const statusConfig = saveStatusConfig[saveStatus];

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
            Modified {formatRelativeTime(note.updated_at)}
          </span>
        </div>
      </div>

      {/* Editor */}
      <NoteEditor
        key={noteId}
        noteId={noteId}
        initialContent={note.content as Block[] | undefined}
        onChange={handleContentChange}
      />
    </div>
  );
}
