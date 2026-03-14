"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { handleAuthError } from "@/lib/handle-auth-error";

interface SearchResult {
  id: string;
  title: string;
  notebook_id: string;
  is_trashed: boolean;
  trashed_at: string | null;
  updated_at: string;
  content_snippet: string;
}

interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
  onSelectNote: (noteId: string, notebookId: string, isTrashed: boolean) => void;
  notebooks: Array<{ id: string; name: string }>;
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export function SearchOverlay({ open, onClose, onSelectNote, notebooks }: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notebookMap = new Map(notebooks.map((n) => [n.id, n.name]));

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    const controller = new AbortController();

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    timerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/notes/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (handleAuthError(res)) return;
        if (!res.ok) {
          console.error("Search failed:", res.status);
          setResults([]);
          return;
        }
        const data: SearchResult[] = await res.json();
        setResults(data);
        setHighlightedIndex(0);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Search failed:", err);
        setResults([]);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      controller.abort();
    };
  }, [query]);

  const selectResult = useCallback(
    (result: SearchResult) => {
      onSelectNote(result.id, result.notebook_id, result.is_trashed);
    },
    [onSelectNote],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < results.length - 1 ? prev + 1 : prev));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        return;
      }

      if (e.key === "Enter" && results.length > 0) {
        e.preventDefault();
        selectResult(results[highlightedIndex]);
      }
    },
    [results, highlightedIndex, onClose, selectResult],
  );

  if (!open) return null;

  const trimmed = query.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

      {/* Card */}
      <div className="bg-bg relative z-10 flex w-full max-w-lg flex-col rounded-xl shadow-lg">
        {/* Header */}
        <div className="border-border flex items-center gap-2 border-b p-3">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes..."
            className="flex-1"
          />
          <IconButton size="sm" onClick={onClose} aria-label="Close search">
            <CloseIcon />
          </IconButton>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto p-2">
          {loading && <p className="text-fg-muted px-3 py-4 text-center text-sm">Searching...</p>}

          {!loading && trimmed && results.length === 0 && (
            <p className="text-fg-muted px-3 py-4 text-center text-sm">No notes found</p>
          )}

          {!loading &&
            results.map((result, index) => (
              <button
                key={result.id}
                type="button"
                className={cn(
                  "flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left",
                  index === highlightedIndex ? "bg-bg-muted" : "hover:bg-bg-muted",
                )}
                onClick={() => selectResult(result)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-fg truncate font-medium">{result.title || "Untitled"}</span>
                  <Badge>{notebookMap.get(result.notebook_id) ?? "Unknown"}</Badge>
                  {result.is_trashed && <Badge variant="warning">Trash</Badge>}
                </div>
                {result.content_snippet && (
                  <p className="text-fg-muted truncate text-sm">{result.content_snippet}</p>
                )}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
