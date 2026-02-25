"use client";

import { useEffect, useRef, useState } from "react";

interface Notebook {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface NotebooksSidebarProps {
  selectedNotebookId: string | null;
  onSelectNotebook: (id: string | null) => void;
}

export function NotebooksSidebar({ selectedNotebookId, onSelectNotebook }: NotebooksSidebarProps) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    fetch("/api/notebooks")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load notebooks: ${res.status}`);
        return (await res.json()) as Notebook[];
      })
      .then((data) => {
        setNotebooks(data);
        if (data.length > 0 && !selectedNotebookId) {
          onSelectNotebook(data[0].id);
        }
      })
      .catch(() => {})
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
        setNotebooks((prev) => [...prev, notebook].sort((a, b) => a.name.localeCompare(b.name)));
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
        setNotebooks((prev) =>
          prev.map((n) => (n.id === id ? updated : n)).sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
    } finally {
      setEditingId(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/notebooks/${id}`, { method: "DELETE" });

      if (res.ok) {
        setNotebooks((prev) => prev.filter((n) => n.id !== id));
        if (selectedNotebookId === id) {
          onSelectNotebook(null);
        }
      }
    } catch {
      // Network error — UI state unchanged
    }
  }

  if (loading) {
    return <div className="p-4 text-sm text-gray-400">Loading...</div>;
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold text-gray-700">Notebooks</h2>
        <button
          type="button"
          onClick={handleCreate}
          className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
          aria-label="New notebook"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto">
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
                  className="w-full rounded px-2 py-1.5 text-sm"
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
                  className={`group flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
                    selectedNotebookId === notebook.id
                      ? "bg-blue-100 text-blue-700"
                      : "text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  <span className="truncate">{notebook.name}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(notebook.id);
                    }}
                    className="hidden rounded p-0.5 text-gray-400 group-hover:block hover:text-red-500"
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
                placeholder="Notebook name"
                className="w-full rounded px-2 py-1.5 text-sm"
              />
            </li>
          )}
        </ul>
      </nav>
    </div>
  );
}
