"use client";

import { use, useState, useCallback } from "react";
import { formatRelativeTime } from "@/lib/format-utils";

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
  onRestore: (noteId: string) => void;
  onPermanentDelete: (noteId: string) => void;
  refreshTrigger?: number;
}

const trashCache = new Map<string, Promise<TrashedNote[]>>();

function fetchTrashedNotes(cacheKey: string): Promise<TrashedNote[]> {
  const cached = trashCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetch("/api/notes/trash")
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch trash: ${res.status}`);
      return res.json();
    })
    .then((data: TrashedNote[]) => data);

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
    (noteId: string) => {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      onRestore(noteId);
    },
    [onRestore],
  );

  const handlePermanentDelete = useCallback(
    (noteId: string) => {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      onPermanentDelete(noteId);
    },
    [onPermanentDelete],
  );

  function getNotebookName(notebookId: string): string {
    return notebooks.find((nb) => nb.id === notebookId)?.name ?? "Unknown";
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold text-gray-700">Trash</h2>
      </div>

      {notes.length === 0 ? (
        <div className="p-4 text-center text-sm text-gray-400">Trash is empty.</div>
      ) : (
        <nav className="flex-1 overflow-y-auto">
          <ul className="space-y-0.5 p-2">
            {notes.map((note) => (
              <li key={note.id} className="group rounded px-3 py-2 hover:bg-gray-50">
                <p className="truncate text-sm font-medium text-gray-700">{note.title}</p>
                <p className="text-xs text-gray-400">
                  {getNotebookName(note.notebook_id)} &middot; {formatRelativeTime(note.trashed_at)}
                </p>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleRestore(note.id)}
                    className="rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePermanentDelete(note.id)}
                    className="rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                  >
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
