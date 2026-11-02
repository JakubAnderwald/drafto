"use client";

import { useCallback, useEffect, useState } from "react";
import { handleAuthError } from "@/lib/handle-auth-error";

/**
 * PostgREST's `max_rows` (`supabase/config.toml`, and the hosted projects' default). A trash
 * list this long may have been cut short, so it can't rule out a notebook's trashed notes.
 */
export const TRASH_LIST_ROW_CAP = 1000;

interface TrashedNote {
  notebook_id: string;
}

export interface NotebookDeleteImpact {
  /** True until the check has settled. Keep the delete confirm disabled meanwhile. */
  checking: boolean;
  /** True when deleting the notebook would permanently delete trashed notes inside it. */
  warnTrashedNotes: boolean;
  /**
   * Checks again as the user confirms, since the notebook's notes can change while the
   * confirm is open (notes trashed, or active notes moved out). Resolves true when the
   * delete can go ahead. Resolves false when it can't yet: the delete would now take
   * trashed notes with it, or the check failed, and the warning wasn't on show, so it now
   * shows and the user has to confirm again; or the session expired and `/login` is loading.
   */
  checkBeforeDelete: () => Promise<boolean>;
}

interface CheckResult {
  notebookId: string;
  warnTrashedNotes: boolean;
}

/** Fetches a JSON list, or returns null when the session expired and `/login` is loading. */
async function fetchList<T>(url: string): Promise<T[] | null> {
  const res = await fetch(url);
  if (handleAuthError(res)) return null;
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new TypeError(`Expected a list from ${url}`);
  return body as T[];
}

function willDeleteTrashedNotes(
  notebookId: string,
  trashed: TrashedNote[],
  activeCount: number,
): boolean {
  // The API refuses to delete a notebook that still holds notes, so nothing would go.
  if (activeCount > 0) return false;
  if (trashed.some((note) => note.notebook_id === notebookId)) return true;
  return trashed.length >= TRASH_LIST_ROW_CAP;
}

/** Resolves to whether to warn, or null when the session expired and `/login` is loading. */
async function checkTrashedNotes(notebookId: string): Promise<boolean | null> {
  try {
    const [trashed, active] = await Promise.all([
      fetchList<TrashedNote>("/api/notes/trash"),
      fetchList<unknown>(`/api/notebooks/${notebookId}/notes`),
    ]);
    if (trashed === null || active === null) return null;
    return willDeleteTrashedNotes(notebookId, trashed, active.length);
  } catch (error) {
    console.error("Failed to check the notebook's trashed notes:", error);
    // Warn when unsure: a needless warning is cheaper than losing notes without one.
    return true;
  }
}

/**
 * What deleting a notebook would take with it. A notebook can be deleted once it holds no
 * active notes, and its trashed notes then go with it through the database's
 * `on delete cascade`. Pass the id of the notebook whose delete confirm is open, or null
 * when none is.
 */
export function useNotebookDeleteImpact(notebookId: string | null): NotebookDeleteImpact {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [shownFor, setShownFor] = useState(notebookId);

  // Another notebook's confirm, or none, forgets the answer, so reopening a confirm checks
  // from scratch.
  if (shownFor !== notebookId) {
    setShownFor(notebookId);
    setResult(null);
  }

  useEffect(() => {
    if (!notebookId) return;
    let cancelled = false;

    void checkTrashedNotes(notebookId).then((warnTrashedNotes) => {
      if (cancelled || warnTrashedNotes === null) return;
      setResult({ notebookId, warnTrashedNotes });
    });

    return () => {
      cancelled = true;
    };
  }, [notebookId]);

  const settled = notebookId !== null && result?.notebookId === notebookId;
  const warnTrashedNotes = settled && result.warnTrashedNotes;

  const checkBeforeDelete = useCallback(async () => {
    if (!notebookId) return false;
    const warn = await checkTrashedNotes(notebookId);
    if (warn === null) return false;
    // Nothing new to tell the user: no trashed notes would go, or the warning was on show.
    if (!warn || warnTrashedNotes) return true;
    // Show the warning, unless the confirm has moved on to another notebook meanwhile.
    setResult((prev) =>
      prev?.notebookId === notebookId ? { notebookId, warnTrashedNotes: true } : prev,
    );
    return false;
  }, [notebookId, warnTrashedNotes]);

  return { checking: notebookId !== null && !settled, warnTrashedNotes, checkBeforeDelete };
}
