"use client";

import { use, useState, useCallback } from "react";
import { formatRelativeTime } from "@/lib/format-utils";
import { handleAuthError } from "@/lib/handle-auth-error";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface TrashedNote {
  id: string;
  title: string;
  notebook_id: string;
  trashed_at: string;
}

interface NotebookOption {
  id: string;
  name: string;
}

interface TrashListProps {
  notebooks: NotebookOption[];
  onRestore: (noteId: string) => void | Promise<void>;
  onPermanentDelete: (noteId: string) => void | Promise<void>;
  refreshTrigger?: number;
}

const trashCache = new Map<string, Promise<TrashedNote[]>>();

function fetchTrashedNotes(cacheKey: string): Promise<TrashedNote[]> {
  const cached = trashCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetch("/api/notes/trash")
    .then((res) => {
      if (handleAuthError(res)) return [] as TrashedNote[];
      if (!res.ok) throw new Error(`Failed to fetch trash: ${res.status}`);
      return res.json();
    })
    .then((data: TrashedNote[]) => data)
    .catch((error) => {
      trashCache.delete(cacheKey);
      throw error;
    });

  trashCache.set(cacheKey, promise);
  return promise;
}

export function TrashList({
  notebooks,
  onRestore,
  onPermanentDelete,
  refreshTrigger = 0,
}: TrashListProps) {
  const cacheKey = `trash-${refreshTrigger}`;
  const initialNotes = use(fetchTrashedNotes(cacheKey));
  const [notes, setNotes] = useState(initialNotes);
  const [prevInitialNotes, setPrevInitialNotes] = useState(initialNotes);

  if (prevInitialNotes !== initialNotes) {
    setPrevInitialNotes(initialNotes);
    setNotes(initialNotes);
  }

  const handleRestore = useCallback(
    async (noteId: string) => {
      const noteToRestore = notes.find((n) => n.id === noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      try {
        await Promise.resolve(onRestore(noteId));
      } catch {
        if (noteToRestore) {
          setNotes((prev) => [...prev, noteToRestore]);
        }
      }
    },
    [onRestore, notes],
  );

  const handlePermanentDelete = useCallback(
    async (noteId: string) => {
      const noteToDelete = notes.find((n) => n.id === noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      try {
        await Promise.resolve(onPermanentDelete(noteId));
      } catch {
        if (noteToDelete) {
          setNotes((prev) => [...prev, noteToDelete]);
        }
      }
    },
    [onPermanentDelete, notes],
  );

  function getNotebookName(notebookId: string): string {
    return notebooks.find((nb) => nb.id === notebookId)?.name ?? "Unknown";
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-border flex items-center justify-between border-b p-3">
        <h2 className="text-fg text-sm font-semibold">Trash</h2>
      </div>

      {notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <svg
            className="text-fg-subtle h-10 w-10"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
            />
          </svg>
          <p className="text-fg-subtle text-sm">Trash is empty.</p>
        </div>
      ) : (
        <nav className="flex-1 overflow-y-auto">
          <ul className="space-y-1.5 p-2">
            {notes.map((note) => (
              <li
                key={note.id}
                className="bg-bg-muted hover:bg-bg-subtle rounded-lg px-3 py-2.5 transition-colors duration-[var(--transition-fast)]"
              >
                <p className="text-fg truncate text-sm font-medium">{note.title}</p>
                <div className="text-fg-muted mt-1 flex items-center gap-2 text-xs">
                  <Badge>{getNotebookName(note.notebook_id)}</Badge>
                  <span>
                    <svg
                      className="mr-0.5 inline-block h-3 w-3"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                      />
                    </svg>
                    {formatRelativeTime(note.trashed_at)}
                  </span>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => handleRestore(note.id)}>
                    Restore
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => handlePermanentDelete(note.id)}>
                    Delete forever
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
