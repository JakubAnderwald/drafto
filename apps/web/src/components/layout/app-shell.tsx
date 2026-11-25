"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NotebooksSidebar } from "@/components/notebooks/notebooks-sidebar";
import { NoteList } from "@/components/notes/note-list";
import { handleAuthError } from "@/lib/handle-auth-error";
import { NoteEditorPanel } from "@/components/notes/note-editor-panel";
import { TrashList } from "@/components/notes/trash-list";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/alert";
import { AppMenu } from "@/components/layout/app-menu";
import { ImportEvernoteDialog } from "@/components/import/import-evernote-dialog";
import { ImportTickTickDialog } from "@/components/import/import-ticktick-dialog";
import { ExportEvernoteDialog } from "@/components/export/export-evernote-dialog";
import { SearchOverlay } from "@/components/search/search-overlay";
import { useNoteRemovals, type NoteRemovalOutcome } from "@/hooks/use-note-removals";
import { usePaneCollapse } from "@/hooks/use-pane-collapse";
import type { NoteListPatch } from "@/lib/note-patch";
import { reportError } from "@/lib/report-error";

interface NotebookInfo {
  id: string;
  name: string;
}

interface NoteListItem {
  id: string;
  title: string;
  updated_at: string;
}

// How a failed delete or move is reported and shown.
interface RemovalFailure {
  where: string;
  description: string;
  message: string;
}

const DELETE_FAILURE: RemovalFailure = {
  where: "app-shell:delete-note",
  description: "Failed to delete note",
  message: "Couldn't delete the note.",
};

const MOVE_FAILURE: RemovalFailure = {
  where: "app-shell:move-note",
  description: "Failed to move note",
  message: "Couldn't move the note.",
};

const CREATE_FAILURE_MESSAGE = "Couldn't create the note. Try again.";

interface InitialNotebook {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  /** Notes not in the trash, shown beside the notebook (PrimeTestLab 11035 S-03). */
  note_count?: number;
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

function PanelCollapseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 19l-7-7 7-7" />
    </svg>
  );
}

function PanelExpandIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5l7 7-7 7" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7" />
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
  // Most changes refresh every pane at once through `refreshTrigger`. A delete or move
  // that settles refreshes the lists alone, and refreshes the editor only when it
  // opens a different note (#461). Refetching the open note re-suspends the editor,
  // which drops the caret and puts the server copy over edits not yet saved
  // (ADR-0032). Each pane's trigger adds its own count to the shared one. Both counts
  // only grow, so the sum changes whenever either does and stays 0 until a refresh.
  const [listOnlyRefreshes, setListOnlyRefreshes] = useState(0);
  const [editorOnlyRefreshes, setEditorOnlyRefreshes] = useState(0);
  const listRefreshTrigger = refreshTrigger + listOnlyRefreshes;
  const editorRefreshTrigger = refreshTrigger + editorOnlyRefreshes;
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>(
    initialNotebooks.map((n) => ({ id: n.id, name: n.name })),
  );
  const [viewingTrash, setViewingTrash] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showTickTickImportDialog, setShowTickTickImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { notebooksCollapsed, notesCollapsed, togglePane } = usePaneCollapse();
  const [lastNoteUpdate, setLastNoteUpdate] = useState<NoteListPatch | null>(null);
  // A failed create, delete or move, shown above the note list. The next one of those
  // clears it, and so does a notebook switch: the notebook it was shown with is kept so
  // a render can tell the selection changed (React's "adjust state on a change" pattern).
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorNotebookId, setActionErrorNotebookId] = useState(selectedNotebookId);
  if (actionErrorNotebookId !== selectedNotebookId) {
    setActionErrorNotebookId(selectedNotebookId);
    setActionError(null);
  }

  // The selection as last committed, for code that runs when a request settles. A
  // layout effect updates it during the commit, before any later response can read it.
  const committedNoteId = useRef(selectedNoteId);
  useLayoutEffect(() => {
    committedNoteId.current = selectedNoteId;
  }, [selectedNoteId]);
  const committedNotebookId = useRef(selectedNotebookId);
  useLayoutEffect(() => {
    committedNotebookId.current = selectedNotebookId;
  }, [selectedNotebookId]);

  // Shows a failure only while the notebook its action started in is still selected. A
  // response that lands after a switch is still reported, but its message would sit
  // over a different notebook's notes. A later action in the same notebook doesn't hide
  // an earlier one's failure: that note still failed, and the user needs to know.
  const showActionError = useCallback((startedIn: string | null, message: string) => {
    if (committedNotebookId.current === startedIn) setActionError(message);
  }, []);

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

  const handleSelectNote = useCallback((noteId: string | null) => {
    setSelectedNoteId(noteId);
    // Clearing the selection loads nothing, so there is nothing to refresh.
    if (noteId !== null) {
      setRefreshTrigger((prev) => prev + 1);
    }
  }, []);

  const handleNoteUpdated = useCallback((patch: NoteListPatch) => {
    setLastNoteUpdate(patch);
  }, []);

  // The open note was trashed or deleted on another device and the user dismissed
  // the notice. Distinct from handleDeleteNote, which *performs* a delete — here the
  // write already happened elsewhere, so re-issuing it would be a redundant race.
  const handleNoteClosed = useCallback((noteId: string) => {
    setSelectedNoteId((current) => (current === noteId ? null : current));
    // Safe to bump here: React batches both updates, so the panel unmounts in the
    // same commit rather than re-suspending on a changed cache key.
    setRefreshTrigger((prev) => prev + 1);
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
    setActionError(null);

    try {
      const res = await fetch(`/api/notebooks/${selectedNotebookId}/notes`, {
        method: "POST",
      });

      if (handleAuthError(res)) return;
      if (!res.ok) {
        reportError(new Error(`Failed to create note: ${res.status}`), "app-shell:create-note", {
          extra: { status: res.status, notebookId: selectedNotebookId },
        });
        showActionError(selectedNotebookId, CREATE_FAILURE_MESSAGE);
        return;
      }

      const note: { id: string } = await res.json();
      setSelectedNoteId(note.id);
      setRefreshTrigger((prev) => prev + 1);
    } catch (err) {
      reportError(err, "app-shell:create-note", { extra: { notebookId: selectedNotebookId } });
      showActionError(selectedNotebookId, CREATE_FAILURE_MESSAGE);
    }
  }, [selectedNotebookId, showActionError]);

  const handleSelectNotebook = useCallback((id: string | null) => {
    setSelectedNotebookId(id);
    setSelectedNoteId(null);
    setViewingTrash(false);
    setSidebarOpen(false);
    // Coming back to a notebook must refetch its list: the cached one predates any
    // in-place patches made while it was open. Safe to bump here for the same reason
    // as in handleNoteClosed — the editor unmounts in this same commit.
    setRefreshTrigger((prev) => prev + 1);
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

  // The note list has already removed the row. The follow-up selection and the list
  // refresh both wait for the server (#461): a refetch started before the request
  // settled could return the note again, and nothing would correct the list after
  // it. The functional updater keeps a note the user picked meanwhile. The next note
  // gets a fresh load, as a row click gives it, in the same commit that opens it, so
  // the editor loads it once. A note that stays open is not refetched.
  const handleNoteRemoved = useCallback((noteId: string, nextSelectedId: string | null) => {
    setSelectedNoteId((current) => (current === noteId ? nextSelectedId : current));
    if (committedNoteId.current === noteId && nextSelectedId !== null) {
      setEditorOnlyRefreshes((prev) => prev + 1);
    }
  }, []);

  // Only the lists: the editor shows a note the delete or move left in place.
  const refreshLists = useCallback(() => {
    setListOnlyRefreshes((prev) => prev + 1);
  }, []);

  const { beginRemoval, settleRemoval } = useNoteRemovals({
    onRemoved: handleNoteRemoved,
    onRefresh: refreshLists,
  });

  // A delete and a move share one lifecycle: the request's outcome decides the next
  // selection and the refresh. Each caller supplies only its request and how a failure
  // is reported and shown. A signed-out response is neither: the page is leaving.
  const runRemoval = useCallback(
    async (
      noteId: string,
      remainingIds: string[],
      request: () => Promise<Response>,
      failure: RemovalFailure,
    ) => {
      beginRemoval(noteId);
      setActionError(null);
      const startedIn = committedNotebookId.current;
      let outcome: NoteRemovalOutcome = "failed";
      try {
        const res = await request();

        if (handleAuthError(res)) {
          outcome = "signed-out";
          return;
        }
        if (!res.ok) {
          reportError(new Error(`${failure.description}: ${res.status}`), failure.where, {
            extra: { status: res.status, noteId },
          });
          showActionError(startedIn, failure.message);
          return;
        }
        outcome = "removed";
      } catch (err) {
        reportError(err, failure.where, { extra: { noteId } });
        showActionError(startedIn, failure.message);
      } finally {
        settleRemoval(noteId, remainingIds, outcome);
      }
    },
    [beginRemoval, settleRemoval, showActionError],
  );

  const handleDeleteNote = useCallback(
    (noteId: string, remainingIds: string[]) =>
      runRemoval(
        noteId,
        remainingIds,
        () => fetch(`/api/notes/${noteId}`, { method: "DELETE" }),
        DELETE_FAILURE,
      ),
    [runRemoval],
  );

  const handleRestoreNote = useCallback(
    async (noteId: string) => {
      try {
        const res = await fetch(`/api/notes/${noteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_trashed: false }),
        });

        if (handleAuthError(res)) return;
        if (!res.ok) {
          const err = new Error(`Failed to restore note: ${res.status}`);
          setRefreshTrigger((prev) => prev + 1);
          throw err;
        }
        // The restored note is back in its notebook, so any list cached before the
        // restore is stale. Only the lists: a restore never changes the open note, and
        // refetching it would re-suspend an editor opened while the PATCH was in flight.
        refreshLists();
      } catch (err) {
        reportError(err, "app-shell:restore-note", { extra: { noteId } });
        setRefreshTrigger((prev) => prev + 1);
        throw err;
      }
    },
    [refreshLists],
  );

  const handlePermanentDelete = useCallback(async (noteId: string) => {
    try {
      const res = await fetch(`/api/notes/${noteId}/permanent`, {
        method: "DELETE",
      });

      if (handleAuthError(res)) return;
      if (!res.ok) {
        const err = new Error(`Failed to permanently delete note: ${res.status}`);
        setRefreshTrigger((prev) => prev + 1);
        throw err;
      }
    } catch (err) {
      reportError(err, "app-shell:permanent-delete-note", { extra: { noteId } });
      setRefreshTrigger((prev) => prev + 1);
      throw err;
    }
  }, []);

  const handleMoveNote = useCallback(
    (noteId: string, targetNotebookId: string, remainingIds: string[]) =>
      runRemoval(
        noteId,
        remainingIds,
        () =>
          fetch(`/api/notes/${noteId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notebook_id: targetNotebookId }),
          }),
        MOVE_FAILURE,
      ),
    [runRemoval],
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
          Desktop: static, always visible (unless collapsed) */}
      <aside
        data-testid="notebooks-pane"
        className={`${
          mobileView === "notebooks" ? "flex" : "hidden"
        } bg-sidebar-bg min-h-0 w-full flex-col overflow-hidden sm:fixed sm:inset-y-0 sm:left-0 sm:z-30 sm:flex sm:w-60 sm:shrink-0 sm:transition-transform sm:duration-[var(--transition-normal)] sm:ease-in-out lg:static lg:translate-x-0 ${
          sidebarOpen ? "sm:translate-x-0" : "sm:-translate-x-full"
        } ${notebooksCollapsed ? "lg:hidden" : ""}`}
      >
        <div className="flex items-center justify-between p-2">
          <span className="text-fg ml-1 text-sm font-semibold">Drafto</span>
          <div className="flex items-center gap-1">
            <IconButton size="sm" onClick={() => setSearchOpen(true)} aria-label="Search notes">
              <SearchIcon />
            </IconButton>
            <IconButton
              size="sm"
              onClick={() => togglePane("notebooks")}
              aria-label="Collapse notebook list"
              className="hidden lg:inline-flex"
            >
              <PanelCollapseIcon />
            </IconButton>
          </div>
        </div>
        <NotebooksSidebar
          selectedNotebookId={selectedNotebookId}
          onSelectNotebook={handleSelectNotebook}
          onNotebooksChange={setNotebooks}
          isTrashSelected={viewingTrash}
          onSelectTrash={handleSelectTrash}
          refreshTrigger={listRefreshTrigger}
          initialNotebooks={initialNotebooks}
        />
        <div className="flex items-center justify-end p-2">
          <AppMenu
            onImportEvernote={() => setShowImportDialog(true)}
            onImportTickTick={() => setShowTickTickImportDialog(true)}
            onExportEvernote={() => setShowExportDialog(true)}
            isAdmin={isAdmin}
          />
        </div>
      </aside>

      {/* Notebooks expand rail — replaces the notebooks pane when collapsed on desktop.
          Sits in the column position the notebooks pane occupied, so users can tell
          which pane the expand handle controls. */}
      {notebooksCollapsed && (
        <div
          data-testid="notebooks-rail"
          className="bg-sidebar-bg border-border hidden w-11 shrink-0 flex-col items-center border-r p-2 lg:flex"
        >
          <IconButton
            size="sm"
            onClick={() => togglePane("notebooks")}
            aria-label="Show notebook list"
          >
            <PanelExpandIcon />
          </IconButton>
        </div>
      )}

      {/* Middle panel — note list or trash
          Mobile: full-width panel, shown only in notes view
          Tablet/Desktop: fixed 300px width (unless collapsed on desktop) */}
      <section
        data-testid="notes-pane"
        className={`${
          mobileView === "notes" ? "flex" : "hidden"
        } bg-bg min-h-0 w-full flex-col overflow-hidden sm:flex sm:w-[300px] sm:shrink-0 ${
          notesCollapsed ? "lg:hidden" : ""
        }`}
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

        {/* Desktop: collapse note list */}
        <div className="bg-bg-subtle hidden items-center justify-end p-2 lg:flex">
          <IconButton size="sm" onClick={() => togglePane("notes")} aria-label="Collapse note list">
            <PanelCollapseIcon />
          </IconButton>
        </div>

        {actionError && (
          <Alert className="mx-2 mt-2 shrink-0" onDismiss={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}

        {viewingTrash ? (
          <Suspense fallback={<ListLoadingSkeleton label="Loading trash" />}>
            <TrashList
              notebooks={notebooks}
              onRestore={handleRestoreNote}
              onPermanentDelete={handlePermanentDelete}
              refreshTrigger={listRefreshTrigger}
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
              refreshTrigger={listRefreshTrigger}
              lastNoteUpdate={lastNoteUpdate}
              initialNotes={selectedNotebookId === initialNotebookId ? initialNotes : undefined}
            />
          </Suspense>
        ) : (
          <EmptyState icon={<NotebookIcon />} message="Select a notebook" />
        )}
      </section>

      {/* Notes expand rail — replaces the notes pane when collapsed on desktop.
          Sits between the notebooks pane (or its rail) and the editor, in the
          column position the notes pane occupied. */}
      {notesCollapsed && (
        <div
          data-testid="notes-rail"
          className="bg-bg border-border hidden w-11 shrink-0 flex-col items-center border-r p-2 lg:flex"
        >
          <IconButton size="sm" onClick={() => togglePane("notes")} aria-label="Show note list">
            <PanelExpandIcon />
          </IconButton>
        </div>
      )}

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
              refreshTrigger={editorRefreshTrigger}
              onNoteUpdated={handleNoteUpdated}
              onNoteClosed={handleNoteClosed}
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

      {showTickTickImportDialog && (
        <ImportTickTickDialog
          onClose={() => setShowTickTickImportDialog(false)}
          onComplete={(notebookId) => {
            setShowTickTickImportDialog(false);
            setRefreshTrigger((prev) => prev + 1);
            setSelectedNotebookId(notebookId);
            setSelectedNoteId(null);
            setViewingTrash(false);
          }}
        />
      )}

      {showExportDialog && <ExportEvernoteDialog onClose={() => setShowExportDialog(false)} />}

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
