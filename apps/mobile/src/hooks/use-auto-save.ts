import { useCallback, useEffect, useRef, useState } from "react";
import { DEBOUNCE_MS } from "@drafto/shared";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface UseAutoSaveOptions<T> {
  onSave: (value: T) => Promise<void>;
  delayMs?: number;
}

export function useAutoSave<T>({ onSave, delayMs = DEBOUNCE_MS }: UseAutoSaveOptions<T>) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const trigger = useCallback(
    (value: T) => {
      cancel();
      timerRef.current = setTimeout(async () => {
        setStatus("saving");
        try {
          await onSaveRef.current(value);
          setStatus("saved");
        } catch {
          setStatus("error");
        }
      }, delayMs);
    },
    [cancel, delayMs],
  );

  useEffect(() => {
    return cancel;
  }, [cancel]);

  return { trigger, cancel, status };
}
