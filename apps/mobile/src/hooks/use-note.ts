import { useState, useEffect } from "react";

import { database, Note } from "@/db";

export function useNote(noteId: string | undefined) {
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!noteId) {
      setNote(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    let subscription: { unsubscribe: () => void } | null = null;

    try {
      subscription = database
        .get<Note>("notes")
        .findAndObserve(noteId)
        .subscribe({
          next: (record) => {
            setNote(record);
            setLoading(false);
          },
          error: (err) => {
            setError(err instanceof Error ? err.message : "Note not found");
            setLoading(false);
          },
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Note not found");
      setLoading(false);
    }

    return () => subscription?.unsubscribe();
  }, [noteId]);

  return { note, loading, error };
}
