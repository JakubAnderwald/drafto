"use client";

import { useEffect, useRef, useState } from "react";
import { handleAuthError } from "@/lib/handle-auth-error";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface Notebook {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface NotebooksSidebarProps {
  selectedNotebookId: string | null;
  onSelectNotebook: (id: string | null) => void;
  onNotebooksChange?: (notebooks: { id: string; name: string }[]) => void;
  isTrashSelected?: boolean;
  onSelectTrash?: () => void;
}

const MAX_NOTEBOOK_NAME_LENGTH = 100;

export function NotebooksSidebar({
  selectedNotebookId,
  onSelectNotebook,
  onNotebooksChange,
  isTrashSelected = false,
  onSelectTrash,
}: NotebooksSidebarProps) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    fetch("/api/notebooks")
      .then(async (res) => {
        if (handleAuthError(res)) return [] as Notebook[];
        if (!res.ok) throw new Error(`Failed to load notebooks: ${res.status}`);
        return (await res.json()) as Notebook[];
      })
      .then((data) => {
        setNotebooks(data);
        onNotebooksChange?.(data.map((n) => ({ id: n.id, name: n.name })));
        if (data.length > 0 && !selectedNotebookId) {
          onSelectNotebook(data[0].id);
        }
      })
      .catch((error) => {
        console.error("Failed to load notebooks:", error);
      })
      .finally(() => setLoading(false));
  }, [selectedNotebookId, onSelectNotebook]);

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

  async function handleCreate() {
    if (creatingName === null) {
      setCreatingName("");
      return;
    }

    const name = creatingName.trim();
    if (!name) {
      setCreatingName(null);
      return;
    }

    try {
      const res = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (res.ok) {
        const notebook: Notebook = await res.json();
        setNotebooks((prev) => {
          const updated = [...prev, notebook].sort((a, b) => a.name.localeCompare(b.name));
          onNotebooksChange?.(updated.map((n) => ({ id: n.id, name: n.name })));
          return updated;
        });
        onSelectNotebook(notebook.id);
      }
    } finally {
      setCreatingName(null);
    }
  }

  async function handleRename(id: string) {
    const name = editingName.trim();
    if (!name) {
      setEditingId(null);
      return;
    }

    try {
      const res = await fetch(`/api/notebooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (res.ok) {
        const updated: Notebook = await res.json();
        setNotebooks((prev) => {
          const newList = prev
            .map((n) => (n.id === id ? updated : n))
            .sort((a, b) => a.name.localeCompare(b.name));
          onNotebooksChange?.(newList.map((n) => ({ id: n.id, name: n.name })));
          return newList;
        });
      }
    } finally {
      setEditingId(null);
    }
  }

  function requestDelete(id: string) {
    setDeleteError(null);
    setConfirmingDeleteId(id);
  }

  function cancelDelete() {
    setConfirmingDeleteId(null);
    setDeleteError(null);
  }

  async function confirmDelete(id: string) {
    setDeleteError(null);
    try {
      const res = await fetch(`/api/notebooks/${id}`, { method: "DELETE" });

      if (handleAuthError(res)) return;
      if (res.ok) {
        setConfirmingDeleteId(null);
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
        setDeleteError(message);
      }
    } catch {
      setDeleteError("Network error. Please try again.");
    }
  }

  if (loading) {
    return (
      <div className="bg-sidebar-bg p-4" data-testid="sidebar-skeleton">
        <div className="mb-4 flex items-center justify-between">
          <Skeleton width="5rem" height="0.75rem" />
          <Skeleton width="1.75rem" height="1.75rem" rounded="md" />
        </div>
        <div className="space-y-2">
          <Skeleton width="100%" height="2rem" />
          <Skeleton width="100%" height="2rem" />
          <Skeleton width="80%" height="2rem" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-sidebar-bg flex flex-1 flex-col">
      <div className="border-border flex items-center justify-between border-b p-3">
        <h2 className="text-fg-muted text-xs font-semibold tracking-wide uppercase">Notebooks</h2>
        <IconButton aria-label="New notebook" variant="ghost" size="sm" onClick={handleCreate}>
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </IconButton>
      </div>

      <nav className="flex-1 overflow-y-auto">
        {notebooks.length === 0 && creatingName === null && (
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
                d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
              />
            </svg>
            <p className="text-fg-subtle text-sm">No notebooks yet. Create one to get started.</p>
          </div>
        )}
        <ul className="space-y-0.5 p-2">
          {notebooks.map((notebook) => (
            <li key={notebook.id}>
              {editingId === notebook.id ? (
                <input
                  ref={editInputRef}
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => handleRename(notebook.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename(notebook.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  maxLength={MAX_NOTEBOOK_NAME_LENGTH}
                  className="border-border focus:ring-ring w-full rounded-md border px-2 py-1.5 text-sm focus:ring-1 focus:outline-none"
                />
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectNotebook(notebook.id)}
                  onDoubleClick={() => {
                    setEditingId(notebook.id);
                    setEditingName(notebook.name);
                  }}
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
                      ? "bg-sidebar-active text-sidebar-active-text border-primary-500 border-l-3 font-medium"
                      : "text-fg-muted hover:bg-sidebar-hover hover:text-fg"
                  }`}
                >
                  <span className="truncate">{notebook.name}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDelete(notebook.id);
                    }}
                    className="text-fg-subtle hover:text-error hidden rounded p-0.5 transition-colors group-focus-within:block group-hover:block"
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
                onChange={(e) => setCreatingName(e.target.value)}
                onBlur={handleCreate}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") setCreatingName(null);
                }}
                maxLength={MAX_NOTEBOOK_NAME_LENGTH}
                placeholder="Notebook name"
                className="border-border focus:ring-ring w-full rounded-md border px-2 py-1.5 text-sm focus:ring-1 focus:outline-none"
              />
            </li>
          )}
        </ul>
      </nav>

      {/* Delete confirmation dialog */}
      {confirmingDeleteId && (
        <ConfirmDialog
          title={`Delete "${notebooks.find((n) => n.id === confirmingDeleteId)?.name}"?`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="danger"
          error={deleteError}
          onConfirm={() => confirmDelete(confirmingDeleteId)}
          onCancel={cancelDelete}
        />
      )}

      {onSelectTrash && (
        <div className="border-border border-t p-2">
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
