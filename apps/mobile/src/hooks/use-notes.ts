import { useState, useEffect } from "react";
import { Q } from "@nozbe/watermelondb";

import { database, Note } from "@/db";

export function useNotes(notebookId: string | undefined) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!notebookId) {
      setNotes([]);
      setLoading(false);
      return;
    }

    const subscription = database
      .get<Note>("notes")
      .query(
        Q.where("notebook_id", notebookId),
        Q.where("is_trashed", false),
        Q.sortBy("updated_at", Q.desc),
      )
      .observe()
      .subscribe((records) => {
        setNotes(records);
        setLoading(false);
      });

    return () => subscription.unsubscribe();
  }, [notebookId]);

  return { notes, loading };
}
