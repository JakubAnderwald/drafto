"use client";

import { useCallback, useRef, useState } from "react";
import { md5 } from "js-md5";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { parseEnexStream } from "@/lib/import/enex-stream-parser";
import { handleAuthError } from "@/lib/handle-auth-error";
import {
  BUCKET_NAME,
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_MB,
  StorageQuotaError,
  storageQuotaErrorFromResponse,
  toAttachmentUrl,
} from "@drafto/shared";
import type {
  EnexNote,
  EnexResource,
  ImportAttachmentRef,
  ImportNoteResult,
} from "@/lib/import/types";

/** The browser Supabase client type, without importing @supabase/supabase-js directly. */
type WebSupabaseClient = ReturnType<typeof createClient>;

interface ImportEvernoteDialogProps {
  onClose: () => void;
  onComplete: (notebookId: string) => void;
}

type ImportStatus = "idle" | "importing" | "done" | "error";

/** Attachments already confirmed on a note row, keyed by their index in `note.resources`. */
type UploadedRefs = ReadonlyMap<number, ImportAttachmentRef>;

/** A note to import, optionally resuming an already-created (but unfinished) row. */
interface ImportItem {
  note: EnexNote;
  noteId?: string;
  /**
   * What a failed attempt already uploaded to `noteId`. Their `attachments` rows are
   * still on the note, so a retry reuses them: uploading them again would add
   * duplicate rows and charge the storage quota twice.
   */
  uploaded?: UploadedRefs;
}

interface FailedNote extends ImportItem {
  reason: string;
}

interface SkippedAttachment {
  noteTitle: string;
  fileName: string;
  reason: string;
}

interface RunResult {
  processed: number;
  failed: FailedNote[];
  /** Set when the storage quota stopped the run; the notes after it were not attempted. */
  storageFull: StorageQuotaError | null;
}

const REMAINING_NOT_IMPORTED = "The remaining notes weren't imported.";

/** Thrown when the session is unauthenticated; aborts the whole import. */
class AuthAbortError extends Error {}

/**
 * Thrown when a single note fails; carries the created noteId and the attachments
 * already uploaded to it, so a retry can resume the row without uploading them again.
 */
class NoteImportError extends Error {
  constructor(
    message: string,
    readonly noteId?: string,
    // Set when the note hit the storage quota and its finalize then failed too: the
    // note goes on the retry list (its text was never written) and the import stops.
    readonly storageFull: StorageQuotaError | null = null,
    readonly uploaded?: UploadedRefs,
  ) {
    super(message);
  }
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Upload one resource directly to Supabase Storage (bypassing the ~4.5 MB
 * serverless body limit) and return its en-media match info. The MD5 is
 * computed client-side from the decoded bytes so the finalize step can match it
 * to the note's `<en-media hash>` without re-sending the bytes.
 */
async function uploadAttachment(
  noteId: string,
  resource: EnexResource,
  supabase: WebSupabaseClient,
): Promise<ImportAttachmentRef> {
  const bytes = base64ToBytes(resource.data);
  if (bytes.length === 0) {
    throw new Error("attachment is empty");
  }
  if (bytes.length > MAX_FILE_SIZE) {
    throw new Error(`exceeds ${MAX_FILE_SIZE_MB}MB limit`);
  }

  const hash = md5(bytes); // lowercase hex, matches <en-media hash>

  const urlRes = await fetch(`/api/notes/${noteId}/attachments/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: resource.fileName,
      fileSize: bytes.length,
      mimeType: resource.mime,
    }),
  });
  if (!urlRes.ok) {
    const body = await urlRes.json().catch(() => null);
    throw (
      storageQuotaErrorFromResponse(urlRes.status, body) ??
      new Error(body?.error || `upload-url failed (${urlRes.status})`)
    );
  }
  const { token, filePath } = await urlRes.json();

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .uploadToSignedUrl(filePath, token, new Blob([bytes], { type: resource.mime }), {
      contentType: resource.mime,
    });
  if (uploadError) {
    throw new Error(`upload failed: ${uploadError.message}`);
  }

  const confirmRes = await fetch(`/api/notes/${noteId}/attachments/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filePath, fileSize: bytes.length, mimeType: resource.mime }),
  });
  if (!confirmRes.ok) {
    const body = await confirmRes.json().catch(() => null);
    throw (
      storageQuotaErrorFromResponse(confirmRes.status, body) ??
      new Error(body?.error || `confirm failed (${confirmRes.status})`)
    );
  }
  const data = await confirmRes.json();
  if (typeof data.file_path !== "string" || data.file_path.length === 0) {
    throw new Error("confirm returned no file path");
  }

  return { md5: hash, url: toAttachmentUrl(data.file_path), name: resource.fileName };
}

interface ImportContext {
  notebookId?: string;
  notebookName: string;
  supabase: WebSupabaseClient;
  onSkippedAttachment: (skip: SkippedAttachment) => void;
}

/**
 * Import one note: create the row (or resume an existing one), upload its
 * attachments directly, then convert + write its content. Mutates
 * `ctx.notebookId` as soon as the notebook exists so the notebook is created
 * only once even if a later note fails. Attachment failures are recorded but do
 * not fail the note; any other failure throws a NoteImportError carrying the
 * noteId so a retry can resume the same row instead of creating a duplicate. It
 * also carries the attachments already uploaded, which a retry reuses (see
 * `ImportItem.uploaded`); only the ones not uploaded yet are tried again.
 *
 * When the storage quota refuses an attachment, the note's remaining attachments
 * are not tried and the note is finalized with the ones already uploaded (this
 * attempt's, and an earlier attempt's after the refused one), so its text is kept. The refusal is returned so the caller stops the import, or thrown
 * if the finalize failed too.
 */
async function importSingleNote(
  item: ImportItem,
  ctx: ImportContext,
): Promise<StorageQuotaError | null> {
  const { note } = item;
  let noteId = item.noteId;
  // Uploads belong to the row they were confirmed on, so only a resumed row has any.
  const uploaded = new Map<number, ImportAttachmentRef>(noteId ? item.uploaded : undefined);

  if (!noteId) {
    const noteRes = await fetch("/api/import/evernote/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notebookId: ctx.notebookId,
        notebookName: ctx.notebookId ? undefined : ctx.notebookName || "Evernote Import",
        title: note.title,
        created: note.created,
        updated: note.updated,
      }),
    });
    if (handleAuthError(noteRes)) {
      throw new AuthAbortError("Not authenticated");
    }
    if (!noteRes.ok) {
      const body = await noteRes.json().catch(() => null);
      throw new NoteImportError(body?.error || `Failed to create note (${noteRes.status})`);
    }
    const result: ImportNoteResult = await noteRes.json();
    ctx.notebookId = result.notebookId; // reuse for every subsequent note
    noteId = result.noteId;
  }

  const attachments: ImportAttachmentRef[] = [];
  let storageFull: StorageQuotaError | null = null;
  for (const [index, resource] of note.resources.entries()) {
    // An upload an earlier attempt confirmed is kept even after a quota refusal: its
    // row is on the note, and finalize only links the references it is given.
    const reused = uploaded.get(index);
    if (reused) {
      attachments.push(reused);
      continue;
    }
    if (storageFull) continue; // every further upload would be refused too
    try {
      const ref = await uploadAttachment(noteId, resource, ctx.supabase);
      uploaded.set(index, ref);
      attachments.push(ref);
    } catch (err) {
      if (err instanceof StorageQuotaError) {
        storageFull = err;
        continue;
      }
      // A failed attachment must not lose the note's text — record and skip.
      ctx.onSkippedAttachment({
        noteTitle: note.title || "Untitled",
        fileName: resource.fileName,
        reason: errorMessageOf(err),
      });
    }
  }

  let finalizeRes: Response;
  try {
    finalizeRes = await fetch("/api/import/evernote/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId, content: note.content, attachments, tasks: note.tasks }),
    });
  } catch (err) {
    // A network failure leaves the row and its uploads just as resumable.
    throw new NoteImportError(errorMessageOf(err), noteId, storageFull, uploaded);
  }
  if (!finalizeRes.ok) {
    const body = await finalizeRes.json().catch(() => null);
    throw new NoteImportError(
      body?.error || `Failed to finalize note (${finalizeRes.status})`,
      noteId,
      storageFull,
      uploaded,
    );
  }
  return storageFull;
}

/** Wrap the streaming parser so the import loop sees a uniform ImportItem stream. */
async function* streamItems(file: File): AsyncGenerator<ImportItem> {
  for await (const note of parseEnexStream(file)) {
    yield { note };
  }
}

export function ImportEvernoteDialog({ onClose, onComplete }: ImportEvernoteDialogProps) {
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [notebookName, setNotebookName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [currentTitle, setCurrentTitle] = useState("");
  const [failedNotes, setFailedNotes] = useState<FailedNote[]>([]);
  const [skippedAttachments, setSkippedAttachments] = useState<SkippedAttachment[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  // The storage quota stopped the last run; its message stays up until the user closes.
  const [stoppedByQuota, setStoppedByQuota] = useState(false);
  // Persisted across the run and any retry so the count and notebook survive
  // re-renders without forcing runImport to re-create on every imported note.
  const notebookIdRef = useRef<string | undefined>(undefined);
  const importedCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        setSelectedFile(file);
        if (!notebookName) {
          setNotebookName(file.name.replace(/\.enex$/i, ""));
        }
      }
    },
    [notebookName],
  );

  /**
   * Run items through the import pipeline, isolating per-note failures. The first
   * storage quota refusal stops the run: retrying the notes after it would only be
   * refused again, so they are left out of `failed`.
   */
  const runImport = useCallback(
    async (items: AsyncIterable<ImportItem> | Iterable<ImportItem>): Promise<RunResult> => {
      const supabase = createClient();
      const skipped: SkippedAttachment[] = [];
      const failed: FailedNote[] = [];
      let processed = 0;
      let storageFull: StorageQuotaError | null = null;

      const ctx: ImportContext = {
        notebookId: notebookIdRef.current,
        notebookName,
        supabase,
        onSkippedAttachment: (skip) => skipped.push(skip),
      };

      for await (const item of items) {
        processed += 1;
        setCurrentTitle(item.note.title || "Untitled");
        try {
          storageFull = await importSingleNote(item, ctx);
          importedCountRef.current += 1;
          setImportedCount(importedCountRef.current);
        } catch (err) {
          if (err instanceof AuthAbortError) throw err;
          if (err instanceof StorageQuotaError) {
            storageFull = err; // ends the loop below
          } else {
            const resume = err instanceof NoteImportError ? err : undefined;
            failed.push({
              note: item.note,
              noteId: resume?.noteId ?? item.noteId,
              uploaded: resume?.uploaded ?? item.uploaded,
              reason: errorMessageOf(err),
            });
            // Quota stop plus a failed finalize: keep the note retryable, still stop.
            if (err instanceof NoteImportError && err.storageFull) storageFull = err.storageFull;
          }
        } finally {
          // Propagate the notebook id even when a note fails mid-way.
          notebookIdRef.current = ctx.notebookId;
        }
        if (storageFull) break;
      }

      if (skipped.length > 0) {
        setSkippedAttachments((prev) => [...prev, ...skipped]);
      }
      return { processed, failed, storageFull };
    },
    [notebookName],
  );

  /** Show a finished run's outcome; hand the notebook over unless there's a quota message to read. */
  const finishRun = useCallback(
    (result: RunResult) => {
      setFailedNotes(result.failed);
      setStatus("done");
      if (result.storageFull) {
        // onComplete closes the dialog, so it waits for the user's Close (handleClose).
        setStoppedByQuota(true);
        setErrorMessage(`${result.storageFull.message} ${REMAINING_NOT_IMPORTED}`);
        return;
      }
      if (notebookIdRef.current) {
        onComplete(notebookIdRef.current);
      }
    },
    [onComplete],
  );

  const handleImport = useCallback(async () => {
    if (!selectedFile) return;

    setStatus("importing");
    setErrorMessage("");
    setStoppedByQuota(false);
    setImportedCount(0);
    importedCountRef.current = 0;
    notebookIdRef.current = undefined;
    setFailedNotes([]);
    setSkippedAttachments([]);

    let result: RunResult;
    try {
      result = await runImport(streamItems(selectedFile));
    } catch (err) {
      if (err instanceof AuthAbortError) return; // handleAuthError already redirected
      setStatus("error");
      setErrorMessage(errorMessageOf(err) || "Failed to read .enex file");
      return;
    }

    if (result.processed === 0) {
      setStatus("error");
      setErrorMessage("No notes found in the .enex file");
      return;
    }

    finishRun(result);
  }, [selectedFile, runImport, finishRun]);

  const handleRetry = useCallback(async () => {
    const toRetry = failedNotes;
    if (toRetry.length === 0) return;

    setStatus("importing");
    setErrorMessage("");
    setStoppedByQuota(false);
    setFailedNotes([]);

    let result: RunResult;
    try {
      result = await runImport(toRetry);
    } catch (err) {
      if (err instanceof AuthAbortError) return;
      setStatus("error");
      setErrorMessage(errorMessageOf(err));
      return;
    }

    // A quota stop leaves the retry items after it untried. Unlike the notes a first
    // run never reached, they failed once already and may have a row to resume, so
    // they stay on the retry list.
    const untried = result.storageFull ? toRetry.slice(result.processed) : [];
    finishRun(untried.length > 0 ? { ...result, failed: [...result.failed, ...untried] } : result);
  }, [failedNotes, runImport, finishRun]);

  const handleClose = useCallback(() => {
    // A run the quota stopped still imported notes; open their notebook on close.
    if (stoppedByQuota && notebookIdRef.current) {
      onComplete(notebookIdRef.current);
      return;
    }
    onClose();
  }, [stoppedByQuota, onComplete, onClose]);

  const isProcessing = status === "importing";

  const statusText = (() => {
    switch (status) {
      case "importing":
        return currentTitle
          ? `Importing "${currentTitle}"… (${importedCount} done)`
          : "Reading file…";
      case "done":
        if (stoppedByQuota) {
          return failedNotes.length > 0
            ? `Stopped: ${importedCount} imported, ${failedNotes.length} failed`
            : `Stopped: ${importedCount} imported`;
        }
        return failedNotes.length > 0
          ? `Done: ${importedCount} imported, ${failedNotes.length} failed`
          : `Done: ${importedCount} notes imported`;
      case "error":
        return "Import failed";
      default:
        return null;
    }
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      data-testid="import-dialog"
    >
      <div className="bg-bg mx-4 w-full max-w-md rounded-xl p-6 shadow-lg">
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
              {status === "done" && failedNotes.length > 0 && (
                <Badge variant="warning">{failedNotes.length} failed</Badge>
              )}
              {status === "done" && stoppedByQuota && <Badge variant="error">Storage full</Badge>}
              {status === "done" && !stoppedByQuota && failedNotes.length === 0 && (
                <Badge variant="success">Complete</Badge>
              )}
            </div>
          )}

          {failedNotes.length > 0 && (
            <div
              className="border-border max-h-32 overflow-y-auto rounded-md border p-2"
              data-testid="import-failed-list"
            >
              <p className="text-fg mb-1 text-sm font-medium">Failed notes</p>
              <ul className="text-fg-muted space-y-0.5 text-xs">
                {failedNotes.map((f, i) => (
                  <li key={i}>
                    <span className="text-fg">{f.note.title || "Untitled"}</span> — {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {skippedAttachments.length > 0 && (
            <div
              className="border-border max-h-32 overflow-y-auto rounded-md border p-2"
              data-testid="import-skipped-list"
            >
              <p className="text-fg mb-1 text-sm font-medium">
                Skipped attachments ({skippedAttachments.length})
              </p>
              <ul className="text-fg-muted space-y-0.5 text-xs">
                {skippedAttachments.map((s, i) => (
                  <li key={i}>
                    <span className="text-fg">{s.fileName}</span> in “{s.noteTitle}” — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {errorMessage && (
            <p className="text-error text-sm whitespace-pre-line" data-testid="import-error">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={isProcessing}>
            {status === "done" ? "Close" : "Cancel"}
          </Button>
          {status === "done" && failedNotes.length > 0 && (
            <Button onClick={handleRetry} data-testid="retry-failed-button">
              Retry failed
            </Button>
          )}
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
