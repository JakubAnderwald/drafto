"use client";

import { useCallback, useState } from "react";
import { NotebooksSidebar } from "@/components/notebooks/notebooks-sidebar";
import { NoteList } from "@/components/notes/note-list";
import { NoteEditorPanel } from "@/components/notes/note-editor-panel";

export function AppShell({ children }: { children?: React.ReactNode }) {
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleCreateNote = useCallback(async () => {
    if (!selectedNotebookId) return;

    const res = await fetch(`/api/notebooks/${selectedNotebookId}/notes`, {
      method: "POST",
    });

    if (res.ok) {
      const note = await res.json();
      setSelectedNoteId(note.id);
      setRefreshTrigger((prev) => prev + 1);
    }
  }, [selectedNotebookId]);

  const handleSelectNotebook = useCallback((id: string | null) => {
    setSelectedNotebookId(id);
    setSelectedNoteId(null);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — notebooks */}
      <aside className="flex w-60 shrink-0 flex-col border-r bg-gray-50">
        <NotebooksSidebar
          selectedNotebookId={selectedNotebookId}
          onSelectNotebook={handleSelectNotebook}
        />
      </aside>

      {/* Middle panel — note list */}
      <section className="flex w-72 shrink-0 flex-col border-r">
        {selectedNotebookId ? (
          <NoteList
            notebookId={selectedNotebookId}
            selectedNoteId={selectedNoteId}
            onSelectNote={setSelectedNoteId}
            onCreateNote={handleCreateNote}
            refreshTrigger={refreshTrigger}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-400">
            Select a notebook
          </div>
        )}
      </section>

      {/* Main panel — editor */}
      <main className="flex flex-1 flex-col">
        {selectedNoteId ? (
          <NoteEditorPanel noteId={selectedNoteId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-400">Select a note</div>
        )}
      </main>

      {children}
    </div>
  );
}
