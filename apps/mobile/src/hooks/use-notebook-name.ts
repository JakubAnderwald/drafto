import { useState, useEffect } from "react";

import { database, Notebook } from "@/db";

/**
 * The name of one notebook, kept current: a rename (here, on another device,
 * or pulled in by a sync) reaches the screen without a refetch.
 *
 * It tracks the name string rather than the record, because WatermelonDB
 * re-emits the same mutated record instance on every change, and React skips a
 * state update whose value is the same object. Null while loading, and when the
 * notebook is missing.
 */
export function useNotebookName(notebookId: string | undefined): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    setName(null);
    if (!notebookId) return;

    let subscription: { unsubscribe: () => void } | null = null;
    try {
      subscription = database
        .get<Notebook>("notebooks")
        .findAndObserve(notebookId)
        .subscribe({
          next: (record) => setName(record.name),
          error: () => setName(null),
        });
    } catch {
      setName(null);
    }

    return () => subscription?.unsubscribe();
  }, [notebookId]);

  return name;
}
