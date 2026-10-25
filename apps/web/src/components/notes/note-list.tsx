"use client";

import { use, useState, useCallback } from "react";
import { handleAuthError } from "@/lib/handle-auth-error";
import { displayNoteTitle } from "@/lib/note-title";
import { IconButton } from "@/components/ui/icon-button";
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { RelativeTime } from "@/components/notes/relative-time";
import type { NoteListPatch } from "@/lib/note-patch";

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
  lastNoteUpdate?: NoteListPatch | null;
  initialNotes?: NoteListItem[];
}

// Browser-only. On the server this Map would live for the whole process and be
// shared by every user's request, so a server render never reads or writes it.
const notesCache = new Map<string, Promise<NoteListItem[]>>();

function fetchNotes(notebookId: string, cacheKey: string): Promise<NoteListItem[]> {
  // A server render has no origin to resolve the relative URL against, and the
  // layout already prefetches the notes it shows (`initialNotes`). Failing here,
  // before the cache is touched, lets the Suspense boundary fall back to a client
  // render instead of caching a rejected promise for every later request.
  if (typeof window === "undefined") {
    throw new Error(
      "NoteList fetched notes during a server render. Pass the server-fetched notes as initialNotes.",
    );
  }

  const cached = notesCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetch(`/api/notebooks/${notebookId}/notes`)
    .then((res) => {
      if (handleAuthError(res)) return [] as NoteListItem[];
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
  lastNoteUpdate,
  initialNotes: serverNotes,
}: NoteListProps) {
  const cacheKey = `${notebookId}-${refreshTrigger}`;

  // Before the first refresh, the layout's prefetched notes are used as they are, on
  // the server and in the browser alike: nothing is fetched or cached, and hydration
  // sees the list the server sent. Every refresh fetches fresh data. `use()` may be
  // called conditionally, unlike the other hooks.
  const initialNotes =
    serverNotes && refreshTrigger === 0 ? serverNotes : use(fetchNotes(notebookId, cacheKey));
  const [notes, setNotes] = useState(initialNotes);
  const [prevInitialNotes, setPrevInitialNotes] = useState(initialNotes);
  const [prevNoteUpdate, setPrevNoteUpdate] = useState(lastNoteUpdate);
  const [menuOpenForNote, setMenuOpenForNote] = useState<string | null>(null);

  // Update notes when cache key changes (new data loaded via refreshTrigger)
  // Track prevInitialNotes separately so optimistic updates aren't reverted
  if (prevInitialNotes !== initialNotes) {
    setPrevInitialNotes(initialNotes);
    setNotes(initialNotes);
  }

  // Patch a single row in-place after a local save or an externally-observed change
  // (no re-fetch — a refetch here would re-suspend the open editor too).
  if (lastNoteUpdate && lastNoteUpdate !== prevNoteUpdate) {
    setPrevNoteUpdate(lastNoteUpdate);
    // Hoisted to a const because TypeScript drops the narrowing on a destructured
    // parameter once it is referenced inside a closure.
    const patch = lastNoteUpdate;
    setNotes((prev) =>
      "removed" in patch
        ? prev.filter((n) => n.id !== patch.noteId)
        : prev.map((n) =>
            n.id === patch.noteId ? { ...n, updated_at: patch.updatedAt, title: patch.title } : n,
          ),
    );
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

  const otherNotebooks = notebooks.filter((nb) => nb.id !== notebookId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between p-3">
        <h2 className="text-fg-muted text-xs font-semibold tracking-wide uppercase">Notes</h2>
        <IconButton size="sm" variant="ghost" onClick={onCreateNote} aria-label="New note">
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </IconButton>
      </div>

      {notes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-6 text-center">
          <svg
            aria-hidden="true"
            className="text-fg-subtle h-8 w-8"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V9a2 2 0 012-2h2a2 2 0 012 2v9a2 2 0 01-2 2h-2z"
            />
          </svg>
          <p className="text-fg-subtle text-sm">No notes yet. Create one to get started.</p>
        </div>
      ) : (
        <nav className="flex-1 overflow-y-auto">
          <ul className="space-y-0.5 p-2">
            {notes.map((note) => (
              <li key={note.id} className="group relative">
                <button
                  onClick={() => onSelectNote(note.id)}
                  {...(selectedNoteId === note.id && { "data-testid": "note-item-active" })}
                  className={`w-full rounded-md px-3 py-2 text-left transition-colors duration-[var(--transition-fast)] ${
                    selectedNoteId === note.id
                      ? "bg-sidebar-active text-sidebar-active-text border-primary-500 border-l-[3px] font-medium"
                      : "text-fg hover:bg-bg-muted"
                  }`}
                >
                  <p className="truncate text-sm font-medium">{displayNoteTitle(note.title)}</p>
                  <p className="text-fg-subtle mt-0.5 flex items-center gap-1 text-xs">
                    <svg
                      aria-hidden="true"
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <RelativeTime value={note.updated_at} />
                  </p>
                </button>

                {(onDeleteNote || (onMoveNote && otherNotebooks.length > 0)) && (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpenForNote(menuOpenForNote === note.id ? null : note.id);
                    }}
                    className="absolute top-2 right-2 opacity-0 transition-opacity duration-[var(--transition-fast)] group-focus-within:opacity-100 group-hover:opacity-100"
                    aria-label={`Actions for ${displayNoteTitle(note.title)}`}
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
                  </IconButton>
                )}

                <DropdownMenu
                  open={menuOpenForNote === note.id}
                  onClose={() => setMenuOpenForNote(null)}
                  align="right"
                  className="top-8"
                >
                  {onDeleteNote && (
                    <DropdownMenuItem
                      variant="danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(note.id);
                      }}
                    >
                      Delete
                    </DropdownMenuItem>
                  )}
                  {onMoveNote && otherNotebooks.length > 0 && (
                    <>
                      <DropdownMenuLabel>Move to...</DropdownMenuLabel>
                      {otherNotebooks.map((nb) => (
                        <DropdownMenuItem
                          key={nb.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMove(note.id, nb.id);
                          }}
                        >
                          {nb.name}
                        </DropdownMenuItem>
                      ))}
                    </>
                  )}
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
