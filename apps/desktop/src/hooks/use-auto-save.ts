import { useCallback, useEffect, useRef, useState } from "react";
import { DEBOUNCE_MS } from "@drafto/shared";

import {
  recordSaveFailed,
  recordSaveWritten,
  registerPendingSave,
  trackSaveInFlight,
} from "@/lib/pending-saves";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface UseAutoSaveOptions<T> {
  /**
   * Persists `value`. Resolve `false` when there was nothing to write (the
   * value matched what is stored), so the status returns to "idle" instead of
   * claiming "saved" for a save that never happened.
   */
  onSave: (value: T) => Promise<boolean | void>;
  delayMs?: number;
}

export function useAutoSave<T>({ onSave, delayMs = DEBOUNCE_MS }: UseAutoSaveOptions<T>) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);
  const pendingValueRef = useRef<{ value: T } | null>(null);
  // The save that is writing right now, so a flush can wait for it too.
  const inFlightRef = useRef<Promise<void> | null>(null);
  // This hook's identity in the pending-saves registry, which sign-out reads.
  const ownerRef = useRef<object>({});
  // How many saves have started. Saves can overlap, and each writes the whole value, so only
  // the latest one's outcome says whether the latest edit is stored.
  const saveSeqRef = useRef(0);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const save = useCallback(async (value: T): Promise<void> => {
    const seq = ++saveSeqRef.current;
    const isLatest = () => saveSeqRef.current === seq;
    setStatus("saving");
    try {
      const written = await onSaveRef.current(value);
      // Every write counts, but an older one must not clear a newer save's failure.
      if (written !== false) recordSaveWritten(ownerRef.current, isLatest());
      if (isLatest()) setStatus(written === false ? "idle" : "saved");
    } catch {
      // A newer save carries this edit too and reports its own outcome.
      if (!isLatest()) return;
      // The edit is not in the database: sign-out must not count it as safe.
      recordSaveFailed(ownerRef.current);
      setStatus("error");
    }
  }, []);

  const executeSave = useCallback(
    (value: T): Promise<void> => {
      const run = save(value);
      inFlightRef.current = run;
      trackSaveInFlight(run);
      // save() never rejects, so this only clears the marker once the write is done.
      void run.then(() => {
        if (inFlightRef.current === run) inFlightRef.current = null;
      });
      return run;
    },
    [save],
  );

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingValueRef.current = null;
  }, []);

  /** Writes a pending save now; resolves once nothing of this hook is left unwritten. */
  const flush = useCallback(async (): Promise<void> => {
    const pending = pendingValueRef.current;
    if (timerRef.current && pending) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingValueRef.current = null;
      await executeSave(pending.value);
      return;
    }
    await inFlightRef.current;
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

  // Sign-out flushes every mounted auto-save before it counts what is unsynced.
  useEffect(() => registerPendingSave(flush), [flush]);

  useEffect(() => {
    return () => {
      void flush();
    };
  }, [flush]);

  return { trigger, cancel, flush, status };
}
