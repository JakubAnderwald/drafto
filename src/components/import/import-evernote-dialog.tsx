"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { parseEnexFile } from "@/lib/import/enex-parser";
import { handleAuthError } from "@/lib/handle-auth-error";
import type { EnexNote, ImportBatchResult } from "@/lib/import/types";

interface ImportEvernoteDialogProps {
  onClose: () => void;
  onComplete: (notebookId: string) => void;
}

type ImportStatus = "idle" | "parsing" | "importing" | "done" | "error";

const BATCH_SIZE = 5;

export function ImportEvernoteDialog({ onClose, onComplete }: ImportEvernoteDialogProps) {
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [notebookName, setNotebookName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errorMessage, setErrorMessage] = useState("");
  const [importedCount, setImportedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        setSelectedFile(file);
        // Default notebook name from filename
        if (!notebookName) {
          setNotebookName(file.name.replace(/\.enex$/i, ""));
        }
      }
    },
    [notebookName],
  );

  const handleImport = useCallback(async () => {
    if (!selectedFile) return;

    setStatus("parsing");
    setErrorMessage("");

    let notes: EnexNote[];
    try {
      const text = await selectedFile.text();
      notes = parseEnexFile(text);
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to parse .enex file");
      return;
    }

    if (notes.length === 0) {
      setStatus("error");
      setErrorMessage("No notes found in the .enex file");
      return;
    }

    setStatus("importing");
    setProgress({ current: 0, total: notes.length });

    let notebookId: string | undefined;
    let totalImported = 0;
    let totalFailed = 0;
    const allErrors: string[] = [];

    // Split notes into batches
    const batches: EnexNote[][] = [];
    for (let i = 0; i < notes.length; i += BATCH_SIZE) {
      batches.push(notes.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      try {
        const res = await fetch("/api/import/evernote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            notebookName: notebookId ? undefined : notebookName || "Evernote Import",
            notebookId,
            notes: batch,
          }),
        });

        if (handleAuthError(res)) return;

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          totalFailed += batch.length;
          allErrors.push(body?.error || `Batch failed: ${res.status}`);
          continue;
        }

        const result: ImportBatchResult = await res.json();
        notebookId = result.notebookId;
        totalImported += result.notesImported;
        totalFailed += result.notesFailed;
        allErrors.push(...result.errors);
      } catch (err) {
        totalFailed += batch.length;
        allErrors.push(err instanceof Error ? err.message : "Network error");
      }

      setProgress((prev) => ({ ...prev, current: prev.current + batch.length }));
    }

    setImportedCount(totalImported);
    setFailedCount(totalFailed);
    setStatus("done");

    if (allErrors.length > 0) {
      setErrorMessage(`Completed with errors:\n${allErrors.join("\n")}`);
    }

    if (notebookId) {
      onComplete(notebookId);
    }
  }, [selectedFile, notebookName, onComplete]);

  const statusText = (() => {
    switch (status) {
      case "parsing":
        return "Parsing file...";
      case "importing":
        return `Importing note ${Math.min(progress.current + 1, progress.total)} of ${progress.total}...`;
      case "done":
        return failedCount > 0
          ? `Done: ${importedCount} imported, ${failedCount} failed`
          : `Done: ${importedCount} notes imported`;
      case "error":
        return "Import failed";
      default:
        return null;
    }
  })();

  const isProcessing = status === "parsing" || status === "importing";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      data-testid="import-dialog"
    >
      <div className="bg-bg border-border mx-4 w-full max-w-md rounded-lg border p-6 shadow-xl">
        <h2 className="text-fg mb-4 text-lg font-semibold">Import from Evernote</h2>

        <div className="space-y-4">
          <div>
            <label className="text-fg-muted mb-1 block text-sm font-medium">Notebook name</label>
            <Input
              value={notebookName}
              onChange={(e) => setNotebookName(e.target.value)}
              placeholder="My Evernote Notes"
              disabled={isProcessing}
              data-testid="notebook-name-input"
            />
          </div>

          <div>
            <label className="text-fg-muted mb-1 block text-sm font-medium">.enex file</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".enex"
              onChange={handleFileChange}
              disabled={isProcessing}
              className="text-fg file:bg-bg-muted file:text-fg file:border-border text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border file:px-3 file:py-1.5 file:text-sm"
              data-testid="file-input"
            />
          </div>

          {statusText && (
            <div className="flex items-center gap-2" data-testid="import-status">
              {isProcessing && (
                <svg
                  className="text-primary-500 h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
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
              )}
              <span className="text-fg-muted text-sm">{statusText}</span>
              {status === "done" && failedCount > 0 && (
                <Badge variant="warning">{failedCount} failed</Badge>
              )}
              {status === "done" && failedCount === 0 && <Badge variant="success">Complete</Badge>}
            </div>
          )}

          {errorMessage && (
            <p className="text-error text-sm whitespace-pre-line" data-testid="import-error">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isProcessing}>
            {status === "done" ? "Close" : "Cancel"}
          </Button>
          {status !== "done" && (
            <Button
              onClick={handleImport}
              loading={isProcessing}
              disabled={!selectedFile || isProcessing}
              data-testid="start-import-button"
            >
              Import
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
