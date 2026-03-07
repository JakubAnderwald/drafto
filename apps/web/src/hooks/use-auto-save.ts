import { useCallback, useEffect, useRef, useState } from "react";
import { handleAuthError } from "@/lib/handle-auth-error";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface UseAutoSaveOptions {
  noteId: string | null;
  debounceMs?: number;
}

export function useAutoSave({ noteId, debounceMs = 500 }: UseAutoSaveOptions) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
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
      setSaveStatus("saving");

      try {
        const res = await fetch(`/api/notes/${noteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        if (handleAuthError(res)) {
          setSaveStatus("error");
          return;
        }

        setSaveStatus(res.ok ? "saved" : "error");
      } catch {
        setSaveStatus("error");
      } finally {
        savingRef.current = false;
      }

      // If data accumulated while we were saving, save it now
      if (pendingData.current) {
        const queued = pendingData.current;
        pendingData.current = null;
        save(queued);
      }
    },
    [noteId],
  );

  const debouncedSave = useCallback(
    (data: Record<string, unknown>) => {
      pendingData.current = { ...pendingData.current, ...data };

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        if (pendingData.current) {
          const toSave = pendingData.current;
          pendingData.current = null;
          save(toSave);
        }
      }, debounceMs);
    },
    [save, debounceMs],
  );

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

  return { saveStatus, debouncedSave };
}
