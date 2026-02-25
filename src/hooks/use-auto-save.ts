import { useCallback, useEffect, useRef, useState } from "react";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface UseAutoSaveOptions {
  noteId: string | null;
  debounceMs?: number;
}

export function useAutoSave({ noteId, debounceMs = 500 }: UseAutoSaveOptions) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingData = useRef<Record<string, unknown> | null>(null);

  const save = useCallback(
    async (data: Record<string, unknown>) => {
      if (!noteId) return;

      setSaveStatus("saving");

      try {
        const res = await fetch(`/api/notes/${noteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        setSaveStatus(res.ok ? "saved" : "error");
      } catch {
        setSaveStatus("error");
      }
    },
    [noteId],
  );

  const debouncedSave = useCallback(
    (data: Record<string, unknown>) => {
      pendingData.current = data;

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        if (pendingData.current) {
          save(pendingData.current);
          pendingData.current = null;
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
