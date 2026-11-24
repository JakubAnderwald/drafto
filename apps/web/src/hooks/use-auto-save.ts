import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { contentQuotaErrorFromResponse } from "@drafto/shared";
import { handleAuthError } from "@/lib/handle-auth-error";
import { registerPendingSaveFlusher } from "@/lib/pending-saves";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface UseAutoSaveOptions {
  noteId: string | null;
  debounceMs?: number;
}

type SaveData = Record<string, unknown>;

/** Where a save was sent from, for the Sentry report. */
type SaveSource = "autosave" | "unmount" | "page-hide";

type SaveFailure = { error: unknown } | { status: number };

// Browsers cap the bodies of all keepalive requests in flight at 64 KiB combined, and reject
// one that would go over it outright. Stay under it, with headroom for the headers.
const KEEPALIVE_BUDGET_BYTES = 60 * 1024;
let keepaliveBytesInFlight = 0;

/**
 * PATCH a note. `keepalive` lets the request outlive the page (tab close, reload, a
 * full-page navigation), but only while every keepalive body in flight fits the browser's
 * cap: past it, a plain fetch is sent, which still works for everything but a closing page.
 * The fetch starts synchronously, before this returns.
 */
async function sendPatch(noteId: string, data: SaveData): Promise<Response> {
  const body = JSON.stringify(data);
  const bytes = new TextEncoder().encode(body).byteLength;
  const keepalive = keepaliveBytesInFlight + bytes <= KEEPALIVE_BUDGET_BYTES;
  if (keepalive) keepaliveBytesInFlight += bytes;
  try {
    return await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive,
    });
  } finally {
    if (keepalive) keepaliveBytesInFlight -= bytes;
  }
}

/** Report a failed save to Sentry. The payload is note content, so it is never attached. */
function captureSaveFailure(failure: SaveFailure, where: SaveSource, noteId: string) {
  if ("error" in failure) {
    Sentry.captureException(failure.error, { extra: { where, noteId } });
  } else {
    Sentry.captureMessage(`Note autosave failed with HTTP ${failure.status}`, {
      level: "error",
      extra: { where, noteId, status: failure.status },
    });
  }
}

/** A response body, or null when it can't be read. The save itself already landed or failed. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function savedTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function useAutoSave({ noteId, debounceMs = 500 }: UseAutoSaveOptions) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  // The title the server stored with that save. A PATCH returns the whole row, so this
  // is set even when only the content changed, and reflects what was persisted
  // rather than keystrokes still waiting on the debounce.
  const [lastSavedTitle, setLastSavedTitle] = useState<string | null>(null);
  // Mirrors `pendingData`/`timerRef` as render-visible state. Consumers need to know
  // whether the editor holds unflushed local edits (refs alone never re-render).
  const [hasPendingChanges, setHasPendingChanges] = useState(false);
  // Why the last save failed, when it is something the user can act on: the content
  // quota (ADR 0090). Null for other failures and after the next successful save.
  const [saveError, setSaveError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingData = useRef<SaveData | null>(null);
  const savingRef = useRef(false);
  // The drain loop in flight, so a flush (logout) can wait for it.
  const drainRef = useRef<Promise<void> | null>(null);
  // The note this hook currently saves to, or null once it has unmounted. A save that
  // fails after that has no one left to retry it.
  const activeNoteIdRef = useRef<string | null>(null);
  // Set once a save comes back 401: the redirect to /login is under way, and nothing
  // more is sent against the dead session.
  const sessionExpiredRef = useRef(false);
  // Sentry gets one event per streak of failures, not one per keystroke pause while
  // offline. The next successful save starts a new streak.
  const failureReportedRef = useRef(false);
  // The newest `updated_at` recorded, so an older response landing late (a page-hide
  // flush overtook it) doesn't roll `lastSavedAt` back.
  const lastSavedAtRef = useRef<string | null>(null);
  // The payload the drain loop has in flight, and whether a flush has since re-sent it
  // (with newer edits on top). A superseded request's failure restores nothing: the newer
  // request carries everything it did.
  const inFlightRef = useRef<SaveData | null>(null);
  const supersededRef = useRef(false);
  // Bumped by `cancelPendingSave`. A request sent before a cancel carries discarded edits,
  // so its failure must not bring them back.
  const cancelGenRef = useRef(0);

  const recordSaved = useCallback((updated: unknown) => {
    if (typeof updated !== "object" || updated === null) return;
    const { updated_at: updatedAt, title } = updated as { updated_at?: unknown; title?: unknown };
    if (typeof updatedAt !== "string") return;
    const previous = lastSavedAtRef.current;
    if (previous && savedTimestamp(updatedAt) < savedTimestamp(previous)) return;
    lastSavedAtRef.current = updatedAt;
    setLastSavedAt(updatedAt);
    setLastSavedTitle(typeof title === "string" ? title : null);
  }, []);

  const reportFailure = useCallback(
    (failure: SaveFailure, where: SaveSource) => {
      if (!noteId || failureReportedRef.current) return;
      failureReportedRef.current = true;
      captureSaveFailure(failure, where, noteId);
    },
    [noteId],
  );

  /** Put a failed payload back in the queue, under anything typed since. */
  const restorePending = useCallback(
    (data: SaveData) => {
      if (!noteId || activeNoteIdRef.current !== noteId) return false;
      pendingData.current = { ...data, ...pendingData.current };
      setHasPendingChanges(true);
      return true;
    },
    [noteId],
  );

  /**
   * After a failed save: requeue the payload and report the first failure of the streak.
   * When this hook no longer edits the note, nothing will retry it, so always report.
   */
  const handleFailure = useCallback(
    (data: SaveData, failure: SaveFailure, where: SaveSource) => {
      if (restorePending(data)) {
        reportFailure(failure, where);
      } else if (noteId) {
        captureSaveFailure(failure, where, noteId);
      }
    },
    [noteId, reportFailure, restorePending],
  );

  /** A failed drain-loop request: requeue it, unless it was cancelled or superseded. */
  const settleDrainFailure = useCallback(
    (
      data: SaveData,
      cancelGen: number,
      failure: SaveFailure | null,
      quotaMessage: string | null,
    ) => {
      if (cancelGen !== cancelGenRef.current) return;
      if (supersededRef.current) {
        // A flush re-sent this payload; that request's outcome decides the status.
        if (failure) reportFailure(failure, "autosave");
        return;
      }
      setSaveStatus("error");
      setSaveError(quotaMessage);
      // Keep the edit queued, under anything typed meanwhile, so the next edit, the
      // unmount flush or a page-hide flush sends it again.
      if (failure) handleFailure(data, failure, "autosave");
      // A content-quota refusal (ADR 0090) is an expected state the editor already
      // shows, not an error worth a Sentry event.
      else restorePending(data);
    },
    [handleFailure, reportFailure, restorePending],
  );

  const expireSession = useCallback(() => {
    sessionExpiredRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingData.current = null;
    setSaveStatus("error");
  }, []);

  const drain = useCallback(
    async (data: SaveData) => {
      if (!noteId) return;
      try {
        // Drain queued data iteratively so we never re-enter `save` recursively
        let toSave: SaveData | null = data;
        while (toSave) {
          setSaveStatus("saving");
          const sent: SaveData = toSave;
          const cancelGen = cancelGenRef.current;
          inFlightRef.current = sent;
          supersededRef.current = false;

          try {
            const res = await sendPatch(noteId, sent);

            if (handleAuthError(res)) {
              // The session has expired and the redirect is under way. The edit can't be
              // saved any more, so drop it rather than send it again in a loop.
              expireSession();
              return;
            }

            if (res.ok) {
              failureReportedRef.current = false;
              setSaveStatus("saved");
              setSaveError(null);
              // The save landed even if its response can't be read.
              recordSaved(await readJson(res));
            } else {
              const body: unknown = await readJson(res);
              const quotaError = contentQuotaErrorFromResponse(res.status, body);
              settleDrainFailure(
                sent,
                cancelGen,
                quotaError ? null : { status: res.status },
                quotaError?.message ?? null,
              );
              // Stop draining: an immediate retry would most likely fail too.
              break;
            }
          } catch (error) {
            settleDrainFailure(sent, cancelGen, { error }, null);
            break;
          }

          // If data accumulated while we were saving, save it now
          toSave = pendingData.current;
          pendingData.current = null;
        }
      } finally {
        savingRef.current = false;
        drainRef.current = null;
        inFlightRef.current = null;
        supersededRef.current = false;
        // The drain loop empties `pendingData`, but a debounce timer scheduled while
        // this save was in flight may have re-filled it — re-read rather than assume.
        setHasPendingChanges(pendingData.current !== null);
      }
    },
    [noteId, expireSession, recordSaved, settleDrainFailure],
  );

  const save = useCallback(
    (data: SaveData) => {
      if (!noteId || sessionExpiredRef.current) return;

      // Guard against concurrent saves — queue data for retry after current save
      if (savingRef.current) {
        pendingData.current = { ...pendingData.current, ...data };
        return;
      }

      savingRef.current = true;
      // `drain` sends its first PATCH synchronously, before it returns its promise.
      drainRef.current = drain(data);
    },
    [noteId, drain],
  );

  /**
   * Send a payload outside the drain loop, for a page that may not live to read the
   * response (unmount, page hide). On failure the payload goes back in the queue while
   * this hook still edits the note; after that it can only be reported.
   */
  const sendDetached = useCallback(
    async (data: SaveData, where: SaveSource) => {
      if (!noteId) return;
      const cancelGen = cancelGenRef.current;
      let failure: SaveFailure | null = null;
      try {
        const res = await sendPatch(noteId, data);
        if (handleAuthError(res)) {
          expireSession();
          return;
        }
        if (res.ok) {
          if (activeNoteIdRef.current === noteId) {
            failureReportedRef.current = false;
            setSaveStatus("saved");
            setSaveError(null);
            recordSaved(await readJson(res));
          }
          return;
        }
        // Discarded by `cancelPendingSave` while in flight: let it go.
        if (cancelGen !== cancelGenRef.current) return;
        const body: unknown = await readJson(res);
        const quotaError = contentQuotaErrorFromResponse(res.status, body);
        if (quotaError) {
          if (restorePending(data)) {
            setSaveStatus("error");
            setSaveError(quotaError.message);
          }
          return;
        }
        failure = { status: res.status };
      } catch (error) {
        if (cancelGen !== cancelGenRef.current) return;
        failure = { error };
      }

      if (activeNoteIdRef.current === noteId) {
        setSaveStatus("error");
        setSaveError(null);
      }
      handleFailure(data, failure, where);
    },
    [noteId, expireSession, recordSaved, handleFailure, restorePending],
  );

  /**
   * The payload to send outside the drain loop: pending edits over the one in flight, if
   * any. Marks the request in flight superseded, so its failure restores nothing.
   */
  const takeOverInFlight = useCallback((pending: SaveData): SaveData => {
    if (!inFlightRef.current) return pending;
    supersededRef.current = true;
    return { ...inFlightRef.current, ...pending };
  }, []);

  /**
   * Send pending edits now instead of waiting for the debounce: the page is being hidden
   * or closed, or the user is logging out. Resolves once the saves it started (and any
   * already in flight) have settled.
   */
  const flushNow = useCallback((): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const waits: Promise<void>[] = [];
    if (noteId && !sessionExpiredRef.current && pendingData.current) {
      const pending = pendingData.current;
      pendingData.current = null;
      if (savingRef.current) {
        // The drain loop would hold this until the save in flight answers, which a
        // closing page never sees. Send it now, over the payload in flight, so this
        // request alone settles both.
        waits.push(sendDetached(takeOverInFlight(pending), "page-hide"));
      } else {
        save(pending);
      }
    }
    if (drainRef.current) waits.push(drainRef.current);
    return Promise.all(waits).then(() => undefined);
  }, [noteId, save, sendDetached, takeOverInFlight]);

  const debouncedSave = useCallback(
    (data: SaveData) => {
      pendingData.current = { ...pendingData.current, ...data };
      setHasPendingChanges(true);

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (pendingData.current) {
          const toSave = pendingData.current;
          pendingData.current = null;
          save(toSave);
        }
      }, debounceMs);
    },
    [save, debounceMs],
  );

  /**
   * Drop unflushed local edits without writing them. Used when the user chooses to
   * discard their in-progress changes in favour of a newer version of the note that
   * arrived from another device — without this, the queued PATCH would land straight
   * after the reload and clobber the remote content again.
   *
   * A save already in flight is not cancellable, but if it fails its payload is not
   * queued again.
   */
  const cancelPendingSave = useCallback(() => {
    cancelGenRef.current += 1;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingData.current = null;
    setHasPendingChanges(false);
  }, []);

  // Flush pending edits when the page is hidden or closed (tab close, reload, a
  // `window.location.href` navigation), where the unmount cleanup below never runs.
  // Logout reaches the same flush through the pending-saves registry, before it signs out.
  useEffect(() => {
    if (!noteId) return;

    const handlePageHide = () => {
      void flushNow();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") void flushNow();
    };

    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const unregister = registerPendingSaveFlusher(() => {
      if (sessionExpiredRef.current) return;
      return flushNow();
    });

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unregister();
    };
  }, [noteId, flushNow]);

  // Flush on unmount (switching notes, or a client-side navigation away from the editor)
  useEffect(() => {
    activeNoteIdRef.current = noteId;
    lastSavedAtRef.current = null;
    return () => {
      activeNoteIdRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingData.current && noteId && !sessionExpiredRef.current) {
        const data = takeOverInFlight(pendingData.current);
        pendingData.current = null;
        void sendDetached(data, "unmount");
      }
    };
  }, [noteId, sendDetached, takeOverInFlight]);

  return {
    saveStatus,
    saveError,
    debouncedSave,
    lastSavedAt,
    lastSavedTitle,
    hasPendingChanges,
    cancelPendingSave,
  };
}
