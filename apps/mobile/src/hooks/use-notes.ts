import { useState, useEffect } from "react";
import { Q } from "@nozbe/watermelondb";

import { database, Note } from "@/db";

export function useNotes(notebookId: string | undefined) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!notebookId) {
      setNotes([]);
      setLoading(false);
      return;
    }

    setError(null);
    const subscription = database
      .get<Note>("notes")
      .query(
        Q.where("notebook_id", notebookId),
        Q.where("is_trashed", false),
        Q.sortBy("updated_at", Q.desc),
      )
      .observe()
      .subscribe({
        next: (records) => {
          setNotes(records);
          setLoading(false);
        },
        error: (err) => {
          setError(err instanceof Error ? err.message : "Failed to load notes");
          setLoading(false);
        },
      });

    return () => subscription.unsubscribe();
  }, [notebookId]);

  return { notes, loading, error };
}
