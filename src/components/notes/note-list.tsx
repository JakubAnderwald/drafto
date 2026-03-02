"use client";

import { use, useState, useCallback, useRef, useEffect } from "react";

interface NoteListItem {
  id: string;
  title: string;
  updated_at: string;
}

interface NotebookOption {
  id: string;
  name: string;
}

interface NoteListProps {
  notebookId: string;
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onCreateNote: () => void;
  onMoveNote?: (noteId: string, targetNotebookId: string) => void;
  onDeleteNote?: (noteId: string) => void;
  notebooks?: NotebookOption[];
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
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch notes: ${res.status}`);
      return res.json();
    })
    .then((data: NoteListItem[]) => data);

  notesCache.set(cacheKey, promise);
  return promise;
}

export function NoteList({
  notebookId,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  onMoveNote,
  onDeleteNote,
  notebooks = [],
  refreshTrigger = 0,
}: NoteListProps) {
  const cacheKey = `${notebookId}-${refreshTrigger}`;
  const initialNotes = use(fetchNotes(notebookId, cacheKey));
  const [notes, setNotes] = useState(initialNotes);
  const [prevInitialNotes, setPrevInitialNotes] = useState(initialNotes);
  const [menuOpenForNote, setMenuOpenForNote] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Update notes when cache key changes (new data loaded via refreshTrigger)
  // Track prevInitialNotes separately so optimistic updates aren't reverted
  if (prevInitialNotes !== initialNotes) {
    setPrevInitialNotes(initialNotes);
    setNotes(initialNotes);
  }

  const handleDelete = useCallback(
    (noteId: string) => {
      setNotes((prev) => {
        const filtered = prev.filter((n) => n.id !== noteId);
        if (selectedNoteId === noteId) {
          onSelectNote(filtered[0]?.id ?? "");
        }
        return filtered;
      });
      setMenuOpenForNote(null);
      onDeleteNote?.(noteId);
    },
    [selectedNoteId, onSelectNote, onDeleteNote],
  );

  const handleMove = useCallback(
    (noteId: string, targetNotebookId: string) => {
      if (!onMoveNote) return;
      setNotes((prev) => {
        const filtered = prev.filter((n) => n.id !== noteId);
        if (selectedNoteId === noteId) {
          onSelectNote(filtered[0]?.id ?? "");
        }
        return filtered;
      });
      setMenuOpenForNote(null);
      onMoveNote(noteId, targetNotebookId);
    },
    [selectedNoteId, onSelectNote, onMoveNote],
  );

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpenForNote) return;

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenForNote(null);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpenForNote]);

  const otherNotebooks = notebooks.filter((nb) => nb.id !== notebookId);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold text-gray-700">Notes</h2>
        <button
          type="button"
          onClick={onCreateNote}
          className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
          aria-label="New note"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
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
              <li key={note.id} className="group relative">
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

                {(onDeleteNote || (onMoveNote && otherNotebooks.length > 0)) && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpenForNote(menuOpenForNote === note.id ? null : note.id);
                    }}
                    className="absolute top-2 right-2 hidden rounded p-0.5 text-gray-400 group-focus-within:block group-hover:block hover:bg-gray-200 hover:text-gray-600"
                    aria-label={`Actions for ${note.title}`}
                  >
                    <svg
                      aria-hidden="true"
                      focusable="false"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 5v.01M12 12v.01M12 19v.01"
                      />
                    </svg>
                  </button>
                )}

                {menuOpenForNote === note.id && (
                  <div
                    ref={menuRef}
                    className="absolute top-8 right-0 z-10 w-48 rounded-md border bg-white py-1 shadow-lg"
                    role="menu"
                  >
                    {onDeleteNote && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(note.id);
                        }}
                        className="w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    )}
                    {onMoveNote && otherNotebooks.length > 0 && (
                      <>
                        <p className="px-3 py-1 text-xs font-medium text-gray-500">Move to...</p>
                        {otherNotebooks.map((nb) => (
                          <button
                            key={nb.id}
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMove(note.id, nb.id);
                            }}
                            className="w-full truncate px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
                          >
                            {nb.name}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
