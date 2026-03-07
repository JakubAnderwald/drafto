import { useState, useEffect } from "react";
import { Q } from "@nozbe/watermelondb";

import { database, Note } from "@/db";

export function useTrashedNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    const subscription = database
      .get<Note>("notes")
      .query(Q.where("is_trashed", true), Q.sortBy("trashed_at", Q.desc))
      .observe()
      .subscribe({
        next: (records) => {
          setNotes(records);
          setLoading(false);
        },
        error: (err) => {
          setError(err instanceof Error ? err.message : "Failed to load trashed notes");
          setLoading(false);
        },
      });

    return () => subscription.unsubscribe();
  }, []);

  return { notes, loading, error };
}
