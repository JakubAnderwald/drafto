"use client";

import { Suspense, useCallback, useState } from "react";
import { NotebooksSidebar } from "@/components/notebooks/notebooks-sidebar";
import { NoteList } from "@/components/notes/note-list";
import { NoteEditorPanel } from "@/components/notes/note-editor-panel";

interface NotebookInfo {
  id: string;
  name: string;
}

export function AppShell({ children }: { children?: React.ReactNode }) {
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>([]);

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
          return;
        }

        // Deselect if the moved note was selected
        if (selectedNoteId === noteId) {
          setSelectedNoteId(null);
        }
        setRefreshTrigger((prev) => prev + 1);
      } catch (err) {
        console.error("Failed to move note:", err);
      }
    },
    [selectedNoteId],
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — notebooks */}
      <aside className="flex w-60 shrink-0 flex-col border-r bg-gray-50">
        <NotebooksSidebar
          selectedNotebookId={selectedNotebookId}
          onSelectNotebook={handleSelectNotebook}
          onNotebooksChange={setNotebooks}
        />
      </aside>

      {/* Middle panel — note list */}
      <section className="flex w-72 shrink-0 flex-col border-r">
        {selectedNotebookId ? (
          <Suspense
            fallback={<div className="p-4 text-center text-sm text-gray-400">Loading notes...</div>}
          >
            <NoteList
              notebookId={selectedNotebookId}
              selectedNoteId={selectedNoteId}
              onSelectNote={setSelectedNoteId}
              onCreateNote={handleCreateNote}
              onMoveNote={handleMoveNote}
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

      {/* Main panel — editor */}
      <main className="flex flex-1 flex-col">
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
