"use client";

import { use, useState } from "react";
import { NoteEditor } from "@/components/editor/note-editor";
import { useAutoSave } from "@/hooks/use-auto-save";
import { handleAuthError } from "@/lib/handle-auth-error";
import type { Block } from "@blocknote/core";

interface NoteEditorPanelProps {
  noteId: string;
}

const MAX_TITLE_LENGTH = 255;

interface NoteData {
  id: string;
  title: string;
  content: Block[] | null;
}

const noteCache = new Map<string, Promise<NoteData | null>>();

function fetchNote(noteId: string): Promise<NoteData | null> {
  const cached = noteCache.get(noteId);
  if (cached) return cached;

  const promise = fetch(`/api/notes/${noteId}`).then((res) => {
    if (handleAuthError(res)) return null;
    return res.ok ? res.json() : null;
  });

  noteCache.set(noteId, promise);
  return promise;
}

export function NoteEditorPanel({ noteId }: NoteEditorPanelProps) {
  const note = use(fetchNote(noteId));
  const [title, setTitle] = useState(note?.title ?? "");
  const { saveStatus, debouncedSave } = useAutoSave({ noteId });

  if (!note) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">Note not found</div>
    );
  }

  function handleTitleChange(newTitle: string) {
    setTitle(newTitle);
    debouncedSave({ title: newTitle });
  }

  function handleContentChange(content: Block[]) {
    debouncedSave({ content });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Title + save indicator */}
      <div className="flex shrink-0 items-center gap-3 border-b px-6 py-3">
        <input
          type="text"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          maxLength={MAX_TITLE_LENGTH}
          className="min-w-0 flex-1 text-lg font-semibold outline-none"
          placeholder="Untitled"
          aria-label="Note title"
        />
        <span className="shrink-0 text-xs text-gray-400">
          {saveStatus === "saving" && "Saving..."}
          {saveStatus === "saved" && "Saved"}
          {saveStatus === "error" && "Error saving"}
        </span>
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
