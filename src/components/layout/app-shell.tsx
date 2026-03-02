"use client";

import { Suspense, useCallback, useState } from "react";
import { NotebooksSidebar } from "@/components/notebooks/notebooks-sidebar";
import { NoteList } from "@/components/notes/note-list";
import { NoteEditorPanel } from "@/components/notes/note-editor-panel";
import { TrashList } from "@/components/notes/trash-list";

interface NotebookInfo {
  id: string;
  name: string;
}

export function AppShell({ children }: { children?: React.ReactNode }) {
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>([]);
  const [viewingTrash, setViewingTrash] = useState(false);

  const handleCreateNote = useCallback(async () => {
    if (!selectedNotebookId) return;

    try {
      const res = await fetch(`/api/notebooks/${selectedNotebookId}/notes`, {
        method: "POST",
      });

      if (!res.ok) {
        console.error("Failed to create note:", res.status);
        return;
      }

      const note: { id: string } = await res.json();
      setSelectedNoteId(note.id);
      setRefreshTrigger((prev) => prev + 1);
    } catch (err) {
      console.error("Failed to create note:", err);
    }
  }, [selectedNotebookId]);

  const handleSelectNotebook = useCallback((id: string | null) => {
    setSelectedNotebookId(id);
    setSelectedNoteId(null);
    setViewingTrash(false);
  }, []);

  const handleSelectTrash = useCallback(() => {
    setViewingTrash(true);
    setSelectedNotebookId(null);
    setSelectedNoteId(null);
  }, []);

  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      try {
        const res = await fetch(`/api/notes/${noteId}`, {
          method: "DELETE",
        });

        if (!res.ok) {
          const err = new Error(`Failed to delete note: ${res.status}`);
          console.error(err);
          setRefreshTrigger((prev) => prev + 1);
          return;
        }

        if (selectedNoteId === noteId) {
          setSelectedNoteId(null);
        }
      } catch (err) {
        console.error("Failed to delete note:", err);
        setRefreshTrigger((prev) => prev + 1);
      }
    },
    [selectedNoteId],
  );

  const handleRestoreNote = useCallback(async (noteId: string) => {
    try {
      const res = await fetch(`/api/notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_trashed: false }),
      });

      if (!res.ok) {
        const err = new Error(`Failed to restore note: ${res.status}`);
        console.error(err);
        setRefreshTrigger((prev) => prev + 1);
        throw err;
      }
    } catch (err) {
      console.error("Failed to restore note:", err);
      setRefreshTrigger((prev) => prev + 1);
      throw err;
    }
  }, []);

  const handlePermanentDelete = useCallback(async (noteId: string) => {
    try {
      const res = await fetch(`/api/notes/${noteId}/permanent`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const err = new Error(`Failed to permanently delete note: ${res.status}`);
        console.error(err);
        setRefreshTrigger((prev) => prev + 1);
        throw err;
      }
    } catch (err) {
      console.error("Failed to permanently delete note:", err);
      setRefreshTrigger((prev) => prev + 1);
      throw err;
    }
  }, []);

  const handleMoveNote = useCallback(
    async (noteId: string, targetNotebookId: string) => {
      try {
        const res = await fetch(`/api/notes/${noteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notebook_id: targetNotebookId }),
        });

        if (!res.ok) {
          console.error("Failed to move note:", res.status);
          setRefreshTrigger((prev) => prev + 1);
          return;
        }

        // Deselect if the moved note was selected
        if (selectedNoteId === noteId) {
          setSelectedNoteId(null);
        }
        setRefreshTrigger((prev) => prev + 1);
      } catch (err) {
        console.error("Failed to move note:", err);
        setRefreshTrigger((prev) => prev + 1);
      }
    },
    [selectedNoteId],
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — notebooks (~240px fixed) */}
      <aside className="flex w-60 shrink-0 flex-col overflow-hidden border-r bg-gray-50">
        <NotebooksSidebar
          selectedNotebookId={selectedNotebookId}
          onSelectNotebook={handleSelectNotebook}
          onNotebooksChange={setNotebooks}
          isTrashSelected={viewingTrash}
          onSelectTrash={handleSelectTrash}
        />
      </aside>

      {/* Middle panel — note list or trash (~300px fixed) */}
      <section className="flex w-[300px] shrink-0 flex-col overflow-hidden border-r">
        {viewingTrash ? (
          <Suspense
            fallback={<div className="p-4 text-center text-sm text-gray-400">Loading trash...</div>}
          >
            <TrashList
              notebooks={notebooks}
              onRestore={handleRestoreNote}
              onPermanentDelete={handlePermanentDelete}
              refreshTrigger={refreshTrigger}
            />
          </Suspense>
        ) : selectedNotebookId ? (
          <Suspense
            fallback={<div className="p-4 text-center text-sm text-gray-400">Loading notes...</div>}
          >
            <NoteList
              notebookId={selectedNotebookId}
              selectedNoteId={selectedNoteId}
              onSelectNote={setSelectedNoteId}
              onCreateNote={handleCreateNote}
              onMoveNote={handleMoveNote}
              onDeleteNote={handleDeleteNote}
              notebooks={notebooks}
              refreshTrigger={refreshTrigger}
            />
          </Suspense>
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-400">
            Select a notebook
          </div>
        )}
      </section>

      {/* Main panel — editor (fills remaining space) */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedNoteId ? (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-gray-400">
                Loading...
              </div>
            }
          >
            <NoteEditorPanel key={selectedNoteId} noteId={selectedNoteId} />
          </Suspense>
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-400">Select a note</div>
        )}
      </main>

      {children}
    </div>
  );
}
