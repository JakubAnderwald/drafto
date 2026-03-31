import { useState, useEffect } from "react";
import { Q } from "@nozbe/watermelondb";

import { database, Attachment } from "@/db";

export function useAttachments(noteId: string | undefined) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!noteId) {
      setAttachments([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const subscription = database
      .get<Attachment>("attachments")
      .query(Q.where("note_id", noteId))
      .observe()
      .subscribe({
        next: (records) => {
          setAttachments(records);
          setLoading(false);
        },
        error: () => {
          setLoading(false);
        },
      });

    return () => subscription.unsubscribe();
  }, [noteId]);

  return { attachments, loading };
}
