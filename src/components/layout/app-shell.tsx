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
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Mobile single-panel navigation: determine which panel is active
  const mobileView: "notebooks" | "notes" | "editor" = selectedNoteId
    ? "editor"
    : selectedNotebookId || viewingTrash
      ? "notes"
      : "notebooks";

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
    setSidebarOpen(false);
  }, []);

  const handleSelectTrash = useCallback(() => {
    setViewingTrash(true);
    setSelectedNotebookId(null);
    setSelectedNoteId(null);
    setSidebarOpen(false);
  }, []);

  const handleMobileBackToNotebooks = useCallback(() => {
    setSelectedNotebookId(null);
    setSelectedNoteId(null);
    setViewingTrash(false);
  }, []);

  const handleMobileBackToNotes = useCallback(() => {
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
      {/* Sidebar backdrop — visible on tablet when sidebar is open */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 hidden bg-black/20 sm:block lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
          data-testid="sidebar-backdrop"
        />
      )}

      {/* Sidebar — notebooks
          Mobile: full-width panel, shown only in notebooks view
          Tablet: fixed overlay, toggled via hamburger
          Desktop: static, always visible */}
      <aside
        className={`${
          mobileView === "notebooks" ? "flex" : "hidden"
        } w-full flex-col overflow-hidden bg-gray-50 sm:fixed sm:inset-y-0 sm:left-0 sm:z-30 sm:flex sm:w-60 sm:shrink-0 sm:border-r sm:transition-transform sm:duration-200 sm:ease-in-out lg:static lg:translate-x-0 ${
          sidebarOpen ? "sm:translate-x-0" : "sm:-translate-x-full"
        }`}
      >
        <NotebooksSidebar
          selectedNotebookId={selectedNotebookId}
          onSelectNotebook={handleSelectNotebook}
          onNotebooksChange={setNotebooks}
          isTrashSelected={viewingTrash}
          onSelectTrash={handleSelectTrash}
        />
      </aside>

      {/* Middle panel — note list or trash
          Mobile: full-width panel, shown only in notes view
          Tablet/Desktop: fixed 300px width */}
      <section
        className={`${
          mobileView === "notes" ? "flex" : "hidden"
        } w-full flex-col overflow-hidden sm:flex sm:w-[300px] sm:shrink-0 sm:border-r`}
      >
        {/* Mobile: back to notebooks */}
        <div className="flex items-center border-b p-2 sm:hidden">
          <button
            type="button"
            onClick={handleMobileBackToNotebooks}
            className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
            aria-label="Back to notebooks"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <span className="ml-1 text-sm font-semibold text-gray-700">
            {viewingTrash ? "Trash" : "Notes"}
          </span>
        </div>

        {/* Tablet: sidebar toggle */}
        <div className="hidden items-center border-b p-2 sm:flex lg:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
            aria-label="Toggle sidebar"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
        </div>

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

      {/* Main panel — editor
          Mobile: full-width panel, shown only in editor view
          Tablet/Desktop: fills remaining space */}
      <main
        className={`${
          mobileView === "editor" ? "flex" : "hidden"
        } min-w-0 flex-1 flex-col overflow-hidden sm:flex`}
      >
        {/* Mobile: back to notes */}
        {selectedNoteId && (
          <div className="flex items-center border-b p-2 sm:hidden">
            <button
              type="button"
              onClick={handleMobileBackToNotes}
              className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
              aria-label="Back to notes"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <span className="ml-1 text-sm font-semibold text-gray-700">Back</span>
          </div>
        )}

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
