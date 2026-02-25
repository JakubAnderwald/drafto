"use client";

import { use, useState, useCallback } from "react";

interface NoteListItem {
  id: string;
  title: string;
  updated_at: string;
}

interface NoteListProps {
  notebookId: string;
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onCreateNote: () => void;
  refreshTrigger?: number;
}

function formatRelativeTime(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

const notesCache = new Map<string, Promise<NoteListItem[]>>();

function fetchNotes(notebookId: string, cacheKey: string): Promise<NoteListItem[]> {
  const cached = notesCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetch(`/api/notebooks/${notebookId}/notes`)
    .then((res) => res.json())
    .then((data: NoteListItem[]) => data);

  notesCache.set(cacheKey, promise);
  return promise;
}

export function NoteList({
  notebookId,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  refreshTrigger = 0,
}: NoteListProps) {
  const cacheKey = `${notebookId}-${refreshTrigger}`;
  const initialNotes = use(fetchNotes(notebookId, cacheKey));
  const [notes, setNotes] = useState(initialNotes);

  // Update notes when cache key changes (new data loaded)
  if (notes !== initialNotes && initialNotes.length > 0) {
    setNotes(initialNotes);
  }

  const handleDelete = useCallback(
    (noteId: string) => {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      if (selectedNoteId === noteId) {
        onSelectNote(notes[0]?.id ?? "");
      }
    },
    [notes, selectedNoteId, onSelectNote],
  );

  // Clear cache for this notebook on unmount-like scenarios
  void handleDelete; // suppress unused warning — used in future Phase 4

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold text-gray-700">Notes</h2>
        <button
          onClick={onCreateNote}
          className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
          aria-label="New note"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {notes.length === 0 ? (
        <div className="p-4 text-center text-sm text-gray-400">
          No notes yet. Create one to get started.
        </div>
      ) : (
        <nav className="flex-1 overflow-y-auto">
          <ul className="space-y-0.5 p-2">
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  onClick={() => onSelectNote(note.id)}
                  className={`w-full rounded px-3 py-2 text-left ${
                    selectedNoteId === note.id
                      ? "bg-blue-100 text-blue-700"
                      : "text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  <p className="truncate text-sm font-medium">{note.title}</p>
                  <p className="text-xs text-gray-400">{formatRelativeTime(note.updated_at)}</p>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
