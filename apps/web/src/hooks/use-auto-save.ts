import { useCallback, useEffect, useRef, useState } from "react";
import { handleAuthError } from "@/lib/handle-auth-error";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface UseAutoSaveOptions {
  noteId: string | null;
  debounceMs?: number;
}

export function useAutoSave({ noteId, debounceMs = 500 }: UseAutoSaveOptions) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  // Mirrors `pendingData`/`timerRef` as render-visible state. Consumers need to know
  // whether the editor holds unflushed local edits (refs alone never re-render).
  const [hasPendingChanges, setHasPendingChanges] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingData = useRef<Record<string, unknown> | null>(null);
  const savingRef = useRef(false);

  const save = useCallback(
    async (data: Record<string, unknown>) => {
      if (!noteId) return;

      // Guard against concurrent saves — queue data for retry after current save
      if (savingRef.current) {
        pendingData.current = { ...pendingData.current, ...data };
        return;
      }

      savingRef.current = true;
      try {
        // Drain queued data iteratively so we never re-enter `save` recursively
        let toSave: Record<string, unknown> | null = data;
        while (toSave) {
          setSaveStatus("saving");

          try {
            const res = await fetch(`/api/notes/${noteId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(toSave),
            });

            if (handleAuthError(res)) {
              setSaveStatus("error");
              return;
            }

            if (res.ok) {
              setSaveStatus("saved");
              const updated = await res.json();
              if (updated?.updated_at) {
                setLastSavedAt(updated.updated_at);
              }
            } else {
              setSaveStatus("error");
            }
          } catch {
            setSaveStatus("error");
          }

          // If data accumulated while we were saving, save it now
          toSave = pendingData.current;
          pendingData.current = null;
        }
      } finally {
        savingRef.current = false;
        // The drain loop empties `pendingData`, but a debounce timer scheduled while
        // this save was in flight may have re-filled it — re-read rather than assume.
        setHasPendingChanges(pendingData.current !== null);
      }
    },
    [noteId],
  );

  const debouncedSave = useCallback(
    (data: Record<string, unknown>) => {
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
   * A save already in flight is not cancellable; only queued work is dropped.
   */
  const cancelPendingSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingData.current = null;
    setHasPendingChanges(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      // Flush pending save on unmount
      if (pendingData.current && noteId) {
        const data = pendingData.current;
        fetch(`/api/notes/${noteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
      }
    };
  }, [noteId]);

  return { saveStatus, debouncedSave, lastSavedAt, hasPendingChanges, cancelPendingSave };
}
