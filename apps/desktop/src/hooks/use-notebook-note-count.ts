import { useState, useEffect } from "react";
import { Q } from "@nozbe/watermelondb";

import { database, Note } from "@/db";

/**
 * How many notes a notebook holds, not counting trashed ones (PrimeTestLab 11035 S-03).
 *
 * WatermelonDB re-counts whenever a note is created, trashed, restored, moved or synced
 * in, so the number beside the notebook stays current. Null until the first count
 * arrives, and when the count can't be read.
 */
export function useNotebookNoteCount(notebookId: string): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    setCount(null);
    const subscription = database
      .get<Note>("notes")
      .query(Q.where("notebook_id", notebookId), Q.where("is_trashed", false))
      .observeCount()
      .subscribe({
        next: (value) => setCount(value),
        error: () => setCount(null),
      });

    return () => subscription.unsubscribe();
  }, [notebookId]);

  return count;
}
