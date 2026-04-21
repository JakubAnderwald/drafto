"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { NotebooksSidebar } from "@/components/notebooks/notebooks-sidebar";
import { NoteList } from "@/components/notes/note-list";
import { handleAuthError } from "@/lib/handle-auth-error";
import { NoteEditorPanel } from "@/components/notes/note-editor-panel";
import { TrashList } from "@/components/notes/trash-list";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { AppMenu } from "@/components/layout/app-menu";
import { ImportEvernoteDialog } from "@/components/import/import-evernote-dialog";
import { SearchOverlay } from "@/components/search/search-overlay";

interface NotebookInfo {
  id: string;
  name: string;
}

interface NoteListItem {
  id: string;
  title: string;
  updated_at: string;
}

interface InitialNotebook {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function ChevronLeftIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  );
}

function ListLoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3 p-4" role="status" aria-label={label} data-testid="list-skeleton">
      <Skeleton height="2.5rem" className="w-full" />
      <Skeleton height="2.5rem" className="w-full" />
      <Skeleton height="2.5rem" className="w-3/4" />
    </div>
  );
}

function EditorLoadingSkeleton() {
  return (
    <div
      className="flex flex-1 flex-col gap-4 p-6"
      role="status"
      aria-label="Loading editor"
      data-testid="editor-skeleton"
    >
      <Skeleton height="2rem" className="w-1/3" />
      <Skeleton height="1rem" className="w-1/4" />
      <Skeleton height="1rem" className="w-full" />
      <Skeleton height="1rem" className="w-full" />
      <Skeleton height="1rem" className="w-2/3" />
    </div>
  );
}

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div
      className="text-fg-subtle flex flex-1 flex-col items-center justify-center gap-3"
      data-testid="empty-state"
    >
      {icon}
      <p className="text-sm">{message}</p>
    </div>
  );
}

function NotebookIcon() {
  return (
    <svg
      className="h-10 w-10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg
      className="h-10 w-10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

interface AppShellProps {
  children?: React.ReactNode;
  initialNotebooks?: InitialNotebook[];
  initialNotebookId?: string | null;
  initialNotes?: NoteListItem[];
  isAdmin?: boolean;
}

export function AppShell({
  children,
  initialNotebooks = [],
  initialNotebookId = null,
  initialNotes = [],
  isAdmin = false,
}: AppShellProps) {
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(initialNotebookId);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>(
    initialNotebooks.map((n) => ({ id: n.id, name: n.name })),
  );
  const [viewingTrash, setViewingTrash] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [lastNoteUpdate, setLastNoteUpdate] = useState<{
    noteId: string;
    updatedAt: string;
  } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        const target = e.target as HTMLElement;
        if (
          target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA"
        ) {
          return;
        }
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelectNote = useCallback((noteId: string) => {
    setSelectedNoteId(noteId);
    setRefreshTrigger((prev) => prev + 1);
  }, []);

  const handleNoteUpdated = useCallback((noteId: string, updatedAt: string) => {
    setLastNoteUpdate({ noteId, updatedAt });
  }, []);

  const handleSearchSelect = useCallback(
    (noteId: string, notebookId: string, isTrashed: boolean) => {
      setSearchOpen(false);
      if (isTrashed) {
        setViewingTrash(true);
        setSelectedNotebookId(null);
        setSelectedNoteId(null);
      } else {
        setViewingTrash(false);
        setSelectedNotebookId(notebookId);
        setSelectedNoteId(noteId);
        setRefreshTrigger((prev) => prev + 1);
      }
    },
    [],
  );

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

      if (handleAuthError(res)) return;
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

        if (handleAuthError(res)) return;
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

      if (handleAuthError(res)) return;
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

      if (handleAuthError(res)) return;
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

        if (handleAuthError(res)) return;
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
    <div className="bg-bg flex h-screen overflow-hidden">
      {/* Sidebar backdrop — visible on tablet when sidebar is open */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 hidden animate-[fade-in_var(--transition-normal)_ease-out] bg-black/30 backdrop-blur-sm motion-reduce:animate-none sm:block lg:hidden"
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
        } bg-sidebar-bg min-h-0 w-full flex-col overflow-hidden sm:fixed sm:inset-y-0 sm:left-0 sm:z-30 sm:flex sm:w-60 sm:shrink-0 sm:transition-transform sm:duration-[var(--transition-normal)] sm:ease-in-out lg:static lg:translate-x-0 ${
          sidebarOpen ? "sm:translate-x-0" : "sm:-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between p-2">
          <span className="text-fg ml-1 text-sm font-semibold">Drafto</span>
          <IconButton size="sm" onClick={() => setSearchOpen(true)} aria-label="Search notes">
            <SearchIcon />
          </IconButton>
        </div>
        <NotebooksSidebar
          selectedNotebookId={selectedNotebookId}
          onSelectNotebook={handleSelectNotebook}
          onNotebooksChange={setNotebooks}
          isTrashSelected={viewingTrash}
          onSelectTrash={handleSelectTrash}
          refreshTrigger={refreshTrigger}
          initialNotebooks={initialNotebooks}
        />
        <div className="flex items-center justify-end p-2">
          <AppMenu onImportEvernote={() => setShowImportDialog(true)} isAdmin={isAdmin} />
        </div>
      </aside>

      {/* Middle panel — note list or trash
          Mobile: full-width panel, shown only in notes view
          Tablet/Desktop: fixed 300px width */}
      <section
        className={`${
          mobileView === "notes" ? "flex" : "hidden"
        } bg-bg w-full flex-col overflow-hidden sm:flex sm:w-[300px] sm:shrink-0`}
      >
        {/* Mobile: back to notebooks */}
        <div className="bg-bg-subtle flex items-center p-2 sm:hidden">
          <IconButton
            size="sm"
            onClick={handleMobileBackToNotebooks}
            aria-label="Back to notebooks"
          >
            <ChevronLeftIcon />
          </IconButton>
          <span className="text-fg ml-1 text-sm font-semibold">
            {viewingTrash ? "Trash" : "Notes"}
          </span>
        </div>

        {/* Tablet: sidebar toggle */}
        <div className="bg-bg-subtle hidden items-center p-2 sm:flex lg:hidden">
          <IconButton
            size="sm"
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-label="Toggle sidebar"
          >
            <HamburgerIcon />
          </IconButton>
        </div>

        {viewingTrash ? (
          <Suspense fallback={<ListLoadingSkeleton label="Loading trash" />}>
            <TrashList
              notebooks={notebooks}
              onRestore={handleRestoreNote}
              onPermanentDelete={handlePermanentDelete}
              refreshTrigger={refreshTrigger}
            />
          </Suspense>
        ) : selectedNotebookId ? (
          <Suspense fallback={<ListLoadingSkeleton label="Loading notes" />}>
            <NoteList
              notebookId={selectedNotebookId}
              selectedNoteId={selectedNoteId}
              onSelectNote={handleSelectNote}
              onCreateNote={handleCreateNote}
              onMoveNote={handleMoveNote}
              onDeleteNote={handleDeleteNote}
              notebooks={notebooks}
              refreshTrigger={refreshTrigger}
              lastNoteUpdate={lastNoteUpdate}
              initialNotes={selectedNotebookId === initialNotebookId ? initialNotes : undefined}
            />
          </Suspense>
        ) : (
          <EmptyState icon={<NotebookIcon />} message="Select a notebook" />
        )}
      </section>

      {/* Main panel — editor
          Mobile: full-width panel, shown only in editor view
          Tablet/Desktop: fills remaining space */}
      <main
        className={`${
          mobileView === "editor" ? "flex" : "hidden"
        } bg-surface-lowest min-w-0 flex-1 flex-col overflow-hidden sm:flex`}
      >
        {/* Mobile: back to notes */}
        {selectedNoteId && (
          <div className="bg-bg-subtle flex items-center p-2 sm:hidden">
            <IconButton size="sm" onClick={handleMobileBackToNotes} aria-label="Back to notes">
              <ChevronLeftIcon />
            </IconButton>
            <span className="text-fg ml-1 text-sm font-semibold">Back</span>
          </div>
        )}

        {selectedNoteId ? (
          <Suspense fallback={<EditorLoadingSkeleton />}>
            <NoteEditorPanel
              key={selectedNoteId}
              noteId={selectedNoteId}
              refreshTrigger={refreshTrigger}
              onNoteUpdated={handleNoteUpdated}
            />
          </Suspense>
        ) : (
          <EmptyState icon={<DocumentIcon />} message="Select a note" />
        )}
      </main>

      {showImportDialog && (
        <ImportEvernoteDialog
          onClose={() => setShowImportDialog(false)}
          onComplete={(notebookId) => {
            setShowImportDialog(false);
            setRefreshTrigger((prev) => prev + 1);
            setSelectedNotebookId(notebookId);
            setSelectedNoteId(null);
            setViewingTrash(false);
          }}
        />
      )}

      {searchOpen && (
        <SearchOverlay
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onSelectNote={handleSearchSelect}
          notebooks={notebooks}
        />
      )}

      {children}
    </div>
  );
}
