import { useState, useEffect } from "react";
import { Q } from "@nozbe/watermelondb";

import { database, Note } from "@/db";

export function useSearch(query: string) {
  const [results, setResults] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const sanitized = Q.sanitizeLikeString(trimmed);
    const subscription = database
      .get<Note>("notes")
      .query(
        Q.experimentalJoinTables(["notebooks"]),
        Q.or(
          Q.where("title", Q.like(`%${sanitized}%`)),
          Q.where("content", Q.like(`%${sanitized}%`)),
          Q.on("notebooks", "name", Q.like(`%${sanitized}%`)),
        ),
        Q.sortBy("updated_at", Q.desc),
      )
      .observe()
      .subscribe({
        next: (records) => {
          setResults(records);
          setLoading(false);
        },
        error: (err) => {
          setError(err instanceof Error ? err.message : "Failed to search notes");
          setLoading(false);
        },
      });

    return () => subscription.unsubscribe();
  }, [query]);

  return { results, loading, error };
}
