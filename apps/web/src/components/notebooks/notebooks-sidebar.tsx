"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { handleAuthError } from "@/lib/handle-auth-error";
import { reportError } from "@/lib/report-error";
import { useNotebookDeleteImpact } from "@/hooks/use-notebook-delete-impact";
import { Alert } from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MAX_NOTEBOOK_NAME_LENGTH,
  duplicateNotebookNameMessage,
  findDuplicateNotebook,
  formatNoteCount,
} from "@drafto/shared";

// The same wording as the mobile and desktop delete confirms.
const TRASHED_NOTES_WARNING = "Trashed notes inside will be permanently deleted.";
const NETWORK_ERROR = "Network error. Please try again.";
// Each field has its own error id: a refused create and a refused rename can both be open.
const CREATE_ERROR_ID = "notebook-create-name-error";
const RENAME_ERROR_ID = "notebook-rename-name-error";

interface Notebook {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  /** Notes not in the trash (PrimeTestLab 11035 S-03). Absent on a create or rename response. */
  note_count?: number;
}

/** The API's error message, or `fallback` when the body carries none. */
async function errorMessageFrom(res: Response, fallback: string): Promise<string> {
  const body: { error?: unknown } | null = await res.json().catch(() => null);
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

/** Why a typed name was refused (PrimeTestLab 11035 M-01), under its field. */
function NameError({ id, message }: Readonly<{ id: string; message: string }>) {
  return (
    <p
      id={id}
      role="alert"
      data-testid="notebook-name-error"
      className="text-error-text mt-1 px-1 text-xs"
    >
      {message}
    </p>
  );
}

interface NotebooksSidebarProps {
  selectedNotebookId: string | null;
  onSelectNotebook: (id: string | null) => void;
  onNotebooksChange?: (notebooks: { id: string; name: string }[]) => void;
  isTrashSelected?: boolean;
  onSelectTrash?: () => void;
  refreshTrigger?: number;
  initialNotebooks?: Notebook[];
}

export function NotebooksSidebar({
  selectedNotebookId,
  onSelectNotebook,
  onNotebooksChange,
  isTrashSelected = false,
  onSelectTrash,
  refreshTrigger = 0,
  initialNotebooks = [],
}: NotebooksSidebarProps) {
  const [notebooks, setNotebooks] = useState<Notebook[]>(initialNotebooks);
  const [loading, setLoading] = useState(initialNotebooks.length === 0);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  // A refused create or rename keeps its field open with the reason under it (PrimeTestLab
  // 11035 M-01): a taken name, or the API's error. Editing the name clears it.
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Each time a field opens or closes it starts a new session. A request belongs to the session
  // that sent it: its error or its closing the field lands only while that session is still the
  // one on show, so a reopened field or another notebook's rename never gets it.
  const createSession = useRef(0);
  const renameSession = useRef(0);
  // The session with a request in flight, per field, so a pending create never swallows Enter
  // on a rename (or the reverse): each only stops a second submit of the same session.
  const submittingCreate = useRef<number | null>(null);
  const submittingRename = useRef<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteImpact = useNotebookDeleteImpact(confirmingDeleteId);
  const createInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const hasFetched = useRef(initialNotebooks.length > 0);
  // Bumped each time a delete confirm opens or closes. A delete that finishes after the user
  // cancelled, or opened another confirm, leaves the confirm now on show alone. One still at
  // its confirm-time check by then sends no DELETE.
  const deleteSession = useRef(0);

  // Set when the last load of the list failed; a later successful load clears it. With no
  // notebooks on show it replaces the empty state with an error and a Retry.
  const [loadError, setLoadError] = useState(false);

  // The selection as last committed, read when a load settles: a Retry can settle long after it
  // was clicked, and must not move a user who has since opened Trash or a notebook.
  const selectionRef = useRef({ selectedNotebookId, isTrashSelected });
  useEffect(() => {
    selectionRef.current = { selectedNotebookId, isTrashSelected };
  }, [selectedNotebookId, isTrashSelected]);

  /**
   * Loads the notebook list. `selectFirst` opens the first notebook when nothing (no notebook, not
   * Trash) is selected (the first load, and its Retry); a refresh leaves the selection alone. A
   * failed load keeps any list already on show and reports the error.
   */
  const loadNotebooks = useCallback(
    ({ selectFirst = false }: { selectFirst?: boolean } = {}) =>
      fetch("/api/notebooks")
        .then(async (res) => {
          if (handleAuthError(res)) return [] as Notebook[];
          if (!res.ok) {
            reportError(
              new Error(`Failed to load notebooks: ${res.status}`),
              "notebooks-sidebar:load",
              { extra: { status: res.status } },
            );
            return null;
          }
          return (await res.json()) as Notebook[];
        })
        .then((data) => {
          if (data === null) {
            setLoadError(true);
            return;
          }
          setNotebooks(data);
          setLoadError(false);
          onNotebooksChange?.(data.map((n) => ({ id: n.id, name: n.name })));
          const selection = selectionRef.current;
          if (
            selectFirst &&
            data.length > 0 &&
            !selection.selectedNotebookId &&
            !selection.isTrashSelected
          ) {
            onSelectNotebook(data[0].id);
          }
        })
        .catch((error: unknown) => {
          reportError(error, "notebooks-sidebar:load");
          setLoadError(true);
        })
        .finally(() => setLoading(false)),
    [onNotebooksChange, onSelectNotebook],
  );

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    void loadNotebooks({ selectFirst: true });
  }, [loadNotebooks]);

  useEffect(() => {
    if (refreshTrigger === 0) return;

    void loadNotebooks();
  }, [refreshTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (creatingName !== null) {
      createInputRef.current?.focus();
    }
  }, [creatingName]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
    }
  }, [editingId]);

  function closeCreate() {
    createSession.current += 1;
    setCreatingName(null);
    setCreateError(null);
  }

  function closeRename() {
    renameSession.current += 1;
    setEditingId(null);
    setRenameError(null);
  }

  /** Opens a notebook's rename field afresh: an earlier refused rename's error doesn't carry over. */
  function startRename(notebook: Notebook) {
    renameSession.current += 1;
    setEditingId(notebook.id);
    setEditingName(notebook.name);
    setRenameError(null);
  }

  async function handleCreate() {
    if (creatingName === null) {
      createSession.current += 1;
      setCreateError(null);
      setCreatingName("");
      return;
    }

    const name = creatingName.trim();
    if (!name) {
      closeCreate();
      return;
    }
    const session = createSession.current;
    if (submittingCreate.current === session) return;

    const duplicate = findDuplicateNotebook(name, notebooks);
    if (duplicate) {
      setCreateError(duplicateNotebookNameMessage(duplicate.name));
      return;
    }

    submittingCreate.current = session;
    const stillOpen = () => createSession.current === session;
    try {
      const res = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (handleAuthError(res)) return;
      if (!res.ok) {
        // A 409 names the notebook that already has the name; the field stays open to fix it.
        const message = await errorMessageFrom(res, "Failed to create notebook");
        if (stillOpen()) setCreateError(message);
        return;
      }

      const created: Notebook = await res.json();
      const notebook: Notebook = { ...created, note_count: created.note_count ?? 0 };
      setNotebooks((prev) => {
        const updated = [...prev, notebook].sort((a, b) => a.name.localeCompare(b.name));
        onNotebooksChange?.(updated.map((n) => ({ id: n.id, name: n.name })));
        return updated;
      });
      onSelectNotebook(notebook.id);
      // A field reopened while this was pending is the user's next name: leave it open.
      if (stillOpen()) closeCreate();
    } catch {
      if (stillOpen()) setCreateError(NETWORK_ERROR);
    } finally {
      if (submittingCreate.current === session) submittingCreate.current = null;
    }
  }

  async function handleRename(id: string) {
    const name = editingName.trim();
    if (!name) {
      closeRename();
      return;
    }
    const session = renameSession.current;
    if (submittingRename.current === session) return;

    const duplicate = findDuplicateNotebook(name, notebooks, id);
    if (duplicate) {
      setRenameError(duplicateNotebookNameMessage(duplicate.name));
      return;
    }

    submittingRename.current = session;
    const stillOpen = () => renameSession.current === session;
    try {
      const res = await fetch(`/api/notebooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (handleAuthError(res)) return;
      if (!res.ok) {
        const message = await errorMessageFrom(res, "Failed to rename notebook");
        if (stillOpen()) setRenameError(message);
        return;
      }

      const updated: Notebook = await res.json();
      setNotebooks((prev) => {
        // The response has no count; the notebook keeps the one it had.
        const newList = prev
          .map((n) => (n.id === id ? { ...n, ...updated } : n))
          .sort((a, b) => a.name.localeCompare(b.name));
        onNotebooksChange?.(newList.map((n) => ({ id: n.id, name: n.name })));
        return newList;
      });
      // Another notebook's rename field, opened while this was pending, stays open.
      if (stillOpen()) closeRename();
    } catch {
      if (stillOpen()) setRenameError(NETWORK_ERROR);
    } finally {
      if (submittingRename.current === session) submittingRename.current = null;
    }
  }

  function requestDelete(id: string) {
    deleteSession.current += 1;
    setDeleting(false);
    setDeleteError(null);
    setConfirmingDeleteId(id);
  }

  function cancelDelete() {
    deleteSession.current += 1;
    setDeleting(false);
    setConfirmingDeleteId(null);
    setDeleteError(null);
  }

  async function confirmDelete(id: string) {
    const session = deleteSession.current;
    const confirmStillOpen = () => deleteSession.current === session;
    setDeleteError(null);
    setDeleting(true);
    try {
      // The notebook's notes may have changed while the confirm was open. If the delete would
      // now take trashed notes with it and the warning isn't on show, the confirm shows it
      // instead of deleting, and the user confirms again.
      const proceed = await deleteImpact.checkBeforeDelete();
      if (!proceed || !confirmStillOpen()) return;

      const res = await fetch(`/api/notebooks/${id}`, { method: "DELETE" });

      if (handleAuthError(res)) return;
      if (res.ok) {
        setConfirmingDeleteId((current) => (current === id ? null : current));
        setNotebooks((prev) => {
          const updated = prev.filter((n) => n.id !== id);
          onNotebooksChange?.(updated.map((n) => ({ id: n.id, name: n.name })));
          return updated;
        });
        if (selectedNotebookId === id) {
          onSelectNotebook(null);
        }
      } else {
        const body = await res.json().catch(() => null);
        const message = body?.error || "Failed to delete notebook";
        if (confirmStillOpen()) setDeleteError(message);
      }
    } catch {
      if (confirmStillOpen()) setDeleteError("Network error. Please try again.");
    } finally {
      if (confirmStillOpen()) setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3 p-4" data-testid="sidebar-skeleton">
        <Skeleton height="12px" width="80px" rounded="sm" />
        <Skeleton height="28px" rounded="md" />
        <Skeleton height="28px" rounded="md" />
        <Skeleton height="28px" rounded="md" />
      </div>
    );
  }

  return (
    <div className="bg-sidebar-bg flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between p-3">
        <h2 className="text-fg-muted text-xs font-semibold tracking-wide uppercase">Notebooks</h2>
        <IconButton size="sm" variant="ghost" onClick={handleCreate} aria-label="New notebook">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </IconButton>
      </div>

      <nav className="flex-1 overflow-y-auto">
        {notebooks.length === 0 && loadError && (
          <div className="p-3">
            <Alert
              action={{ label: "Retry", onClick: () => void loadNotebooks({ selectFirst: true }) }}
            >
              Couldn&apos;t load your notebooks.
            </Alert>
          </div>
        )}
        {notebooks.length === 0 && !loadError && creatingName === null && (
          <div className="flex flex-col items-center gap-2 p-6 text-center">
            <svg
              className="text-fg-subtle h-8 w-8"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
              />
            </svg>
            <p className="text-fg-subtle text-sm">No notebooks yet. Create one to get started.</p>
          </div>
        )}
        <ul className="space-y-0.5 p-2">
          {notebooks.map((notebook) => (
            <li key={notebook.id}>
              {editingId === notebook.id ? (
                <>
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editingName}
                    onChange={(e) => {
                      setEditingName(e.target.value);
                      setRenameError(null);
                    }}
                    // Leaving a refused name doesn't send it again; Escape or a new name does.
                    onBlur={() => {
                      if (!renameError) void handleRename(notebook.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleRename(notebook.id);
                      if (e.key === "Escape") closeRename();
                    }}
                    maxLength={MAX_NOTEBOOK_NAME_LENGTH}
                    aria-label="Notebook name"
                    aria-invalid={renameError ? true : undefined}
                    aria-describedby={renameError ? RENAME_ERROR_ID : undefined}
                    className={`text-fg focus:ring-ring w-full rounded-md border bg-transparent px-2 py-1.5 text-sm transition-colors duration-[var(--transition-fast)] focus:ring-1 focus:outline-none ${
                      renameError ? "border-error" : "border-border"
                    }`}
                  />
                  {renameError && <NameError id={RENAME_ERROR_ID} message={renameError} />}
                </>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectNotebook(notebook.id)}
                  onDoubleClick={() => startRename(notebook)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectNotebook(notebook.id);
                    }
                  }}
                  {...(selectedNotebookId === notebook.id && {
                    "data-testid": "notebook-item-active",
                  })}
                  className={`group flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-[var(--transition-fast)] ${
                    selectedNotebookId === notebook.id
                      ? "bg-sidebar-active text-sidebar-active-text font-medium"
                      : "text-fg hover:bg-sidebar-hover"
                  }`}
                >
                  {/* E2E helpers read the name from here: the row's text includes the count. */}
                  <span data-testid="notebook-name" className="truncate">
                    {notebook.name}
                  </span>
                  {notebook.note_count !== undefined && (
                    <span
                      data-testid="notebook-note-count"
                      className={`ml-auto shrink-0 pl-2 text-xs tabular-nums ${
                        selectedNotebookId === notebook.id
                          ? "text-sidebar-active-text"
                          : "text-fg-muted"
                      }`}
                    >
                      {formatNoteCount(notebook.note_count)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDelete(notebook.id);
                    }}
                    className="text-fg-subtle hover:text-error rounded p-0.5 opacity-0 transition-all duration-[var(--transition-fast)] group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-label={`Delete ${notebook.name}`}
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              )}
            </li>
          ))}

          {creatingName !== null && (
            <li>
              <input
                ref={createInputRef}
                type="text"
                value={creatingName}
                onChange={(e) => {
                  setCreatingName(e.target.value);
                  setCreateError(null);
                }}
                // Leaving a refused name doesn't send it again; Escape or a new name does.
                onBlur={() => {
                  if (!createError) void handleCreate();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") closeCreate();
                }}
                maxLength={MAX_NOTEBOOK_NAME_LENGTH}
                placeholder="Notebook name"
                aria-invalid={createError ? true : undefined}
                aria-describedby={createError ? CREATE_ERROR_ID : undefined}
                className={`text-fg focus:ring-ring w-full rounded-md border bg-transparent px-2 py-1.5 text-sm transition-colors duration-[var(--transition-fast)] focus:ring-1 focus:outline-none ${
                  createError ? "border-error" : "border-border"
                }`}
              />
              {createError && <NameError id={CREATE_ERROR_ID} message={createError} />}
            </li>
          )}
        </ul>
      </nav>

      {confirmingDeleteId && (
        <ConfirmDialog
          title={`Delete "${notebooks.find((n) => n.id === confirmingDeleteId)?.name}"?`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={() => confirmDelete(confirmingDeleteId)}
          onCancel={cancelDelete}
          variant="danger"
          error={deleteError}
          loading={deleting}
          confirmDisabled={deleteImpact.checking}
        >
          {deleteImpact.warnTrashedNotes && TRASHED_NOTES_WARNING}
        </ConfirmDialog>
      )}

      {onSelectTrash && (
        <div className="p-2">
          <button
            type="button"
            onClick={onSelectTrash}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-[var(--transition-fast)] ${
              isTrashSelected
                ? "bg-sidebar-active text-sidebar-active-text font-medium"
                : "text-fg-muted hover:bg-sidebar-hover hover:text-fg"
            }`}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            Trash
          </button>
        </div>
      )}
    </div>
  );
}
