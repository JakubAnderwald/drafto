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
  const pendingValueRef = useRef<{ value: T } | null>(null);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const executeSave = useCallback(async (value: T) => {
    setStatus("saving");
    try {
      await onSaveRef.current(value);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingValueRef.current = null;
  }, []);

  const flush = useCallback(() => {
    const pending = pendingValueRef.current;
    if (timerRef.current && pending) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingValueRef.current = null;
      executeSave(pending.value);
    }
  }, [executeSave]);

  const trigger = useCallback(
    (value: T) => {
      cancel();
      pendingValueRef.current = { value };
      timerRef.current = setTimeout(async () => {
        pendingValueRef.current = null;
        await executeSave(value);
      }, delayMs);
    },
    [cancel, delayMs, executeSave],
  );

  useEffect(() => {
    return flush;
  }, [flush]);

  return { trigger, cancel, flush, status };
}
