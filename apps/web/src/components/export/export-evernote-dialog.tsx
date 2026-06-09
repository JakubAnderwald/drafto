"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { handleAuthError } from "@/lib/handle-auth-error";
import { downloadBlob, filenameFromContentDisposition } from "@/lib/export/download-blob";
import type { ExportNotebookListResponse, ExportNotebookSummary } from "@/lib/api/export-types";

interface ExportEvernoteDialogProps {
  onClose: () => void;
}

type DialogStatus = "loading" | "ready" | "exporting" | "done" | "error";

export function ExportEvernoteDialog({ onClose }: ExportEvernoteDialogProps) {
  const [status, setStatus] = useState<DialogStatus>("loading");
  const [notebooks, setNotebooks] = useState<ExportNotebookSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/export/evernote", { method: "GET" });
        if (handleAuthError(res)) return;
        if (!res.ok) {
          if (!cancelled) {
            setStatus("error");
            setErrorMessage("Failed to load notebooks");
          }
          return;
        }
        const body = (await res.json()) as ExportNotebookListResponse;
        if (cancelled) return;
        setNotebooks(body.notebooks);
        // Pre-select notebooks that have at least one note so the user can
        // export with a single click in the common case.
        setSelectedIds(new Set(body.notebooks.filter((n) => n.noteCount > 0).map((n) => n.id)));
        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(err instanceof Error ? err.message : "Network error");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(notebooks.map((n) => n.id)));
  }, [notebooks]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleExport = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setStatus("exporting");
    setErrorMessage("");
    try {
      const res = await fetch("/api/export/evernote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebookIds: Array.from(selectedIds) }),
      });
      if (handleAuthError(res)) return;
      if (!res.ok) {
        const text = await res.text();
        let msg = `Export failed (${res.status})`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) msg = parsed.error;
        } catch {
          // Non-JSON error body — keep the default status-based message.
        }
        setStatus("error");
        setErrorMessage(msg);
        return;
      }
      const filename =
        filenameFromContentDisposition(res.headers.get("Content-Disposition")) ??
        defaultFilename(selectedIds, notebooks);
      const blob = await res.blob();
      downloadBlob(blob, filename);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Network error");
    }
  }, [selectedIds, notebooks]);

  const totalSelectedNotes = useMemo(
    () => notebooks.filter((n) => selectedIds.has(n.id)).reduce((sum, n) => sum + n.noteCount, 0),
    [notebooks, selectedIds],
  );

  const isProcessing = status === "loading" || status === "exporting";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      data-testid="export-dialog"
    >
      <div className="bg-bg mx-4 w-full max-w-md rounded-xl p-6 shadow-lg">
        <h2 className="text-fg mb-4 text-lg font-semibold">Export to Evernote</h2>

        {status === "loading" && (
          <p className="text-fg-muted text-sm" data-testid="export-loading">
            Loading notebooks…
          </p>
        )}

        {status !== "loading" && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={selectAll}
                  disabled={isProcessing || notebooks.length === 0}
                  data-testid="export-select-all"
                >
                  Select all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={deselectAll}
                  disabled={isProcessing || selectedIds.size === 0}
                  data-testid="export-deselect-all"
                >
                  Deselect all
                </Button>
              </div>
              <span className="text-fg-muted text-xs" data-testid="export-counts">
                {selectedIds.size} notebook{selectedIds.size === 1 ? "" : "s"} ·{" "}
                {totalSelectedNotes} note{totalSelectedNotes === 1 ? "" : "s"}
              </span>
            </div>

            <div
              className="border-border max-h-72 overflow-y-auto rounded-md border"
              data-testid="export-notebook-list"
            >
              {notebooks.length === 0 ? (
                <p className="text-fg-muted p-3 text-sm">No notebooks to export.</p>
              ) : (
                <ul>
                  {notebooks.map((nb) => (
                    <li
                      key={nb.id}
                      className="border-border hover:bg-bg-muted border-b last:border-b-0"
                    >
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(nb.id)}
                          onChange={() => toggle(nb.id)}
                          disabled={isProcessing}
                          data-testid={`export-checkbox-${nb.id}`}
                          className="accent-primary-600"
                        />
                        <span className="text-fg flex-1 truncate text-sm">{nb.name}</span>
                        <span className="text-fg-muted text-xs">{nb.noteCount}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {status === "exporting" && (
              <div className="mt-3 flex items-center gap-2" data-testid="export-status">
                <svg
                  className="text-primary-500 h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                <span className="text-fg-muted text-sm">Building export…</span>
              </div>
            )}

            {status === "done" && (
              <div className="mt-3 flex items-center gap-2" data-testid="export-status">
                <Badge variant="success">Complete</Badge>
                <span className="text-fg-muted text-sm">Your .enex file has been downloaded.</span>
              </div>
            )}

            {errorMessage && (
              <p className="text-error mt-3 text-sm" data-testid="export-error">
                {errorMessage}
              </p>
            )}
          </>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={status === "exporting"}>
            {status === "done" ? "Close" : "Cancel"}
          </Button>
          {status !== "done" && (
            <Button
              onClick={handleExport}
              loading={status === "exporting"}
              disabled={selectedIds.size === 0 || isProcessing}
              data-testid="export-start-button"
            >
              Export
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function defaultFilename(selected: Set<string>, notebooks: ExportNotebookSummary[]): string {
  if (selected.size === 1) {
    const id = Array.from(selected)[0];
    const nb = notebooks.find((n) => n.id === id);
    if (nb) {
      // Bounded input + single-char replace + split/join collapse — avoids the
      // greedy-quantifier regex pattern that SonarCloud's S5852 heuristic trips on.
      const safe = nb.name
        .slice(0, 200)
        .replaceAll(/[^A-Za-z0-9._-]/g, "-")
        .split("-")
        .filter(Boolean)
        .join("-");
      return `${safe || "drafto-export"}.enex`;
    }
  }
  return `drafto-export-${new Date().toISOString().slice(0, 10)}.enex`;
}
