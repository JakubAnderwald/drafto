import { useState, useEffect } from "react";
import { Q } from "@nozbe/watermelondb";

import { database, Notebook } from "@/db";

export function useNotebooks() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const subscription = database
      .get<Notebook>("notebooks")
      .query(Q.where("_status", Q.notEq("deleted")), Q.sortBy("updated_at", Q.desc))
      .observe()
      .subscribe({
        next: (records) => {
          setNotebooks(records);
          setLoading(false);
        },
        error: (err) => {
          setError(err instanceof Error ? err.message : "Failed to load notebooks");
          setLoading(false);
        },
      });

    return () => subscription.unsubscribe();
  }, []);

  return { notebooks, loading, error };
}
