import { useEffect, useState } from "react";
import { Q } from "@nozbe/watermelondb";
import type { AttachmentSizeInfo } from "@drafto/shared";

import { database, type Attachment } from "@/db";

// Mirrors apps/mobile/src/hooks/use-note-attachment-sizes.ts.

const NO_ATTACHMENTS: AttachmentSizeInfo[] = [];

function toSizeInfo(attachment: Attachment): AttachmentSizeInfo {
  return {
    filePath: attachment.filePath,
    fileSize: attachment.fileSize,
    mimeType: attachment.mimeType,
  };
}

/**
 * The path, size and type of every attachment of `noteId`, kept up to date
 * as attachments are added, synced or removed. The editor turns them into
 * the size labels on its file cards (PrimeTestLab 11035 S-04).
 */
export function useNoteAttachmentSizes(noteId: string | undefined): AttachmentSizeInfo[] {
  const [attachments, setAttachments] = useState<AttachmentSizeInfo[]>(NO_ATTACHMENTS);

  useEffect(() => {
    setAttachments(NO_ATTACHMENTS);
    if (!noteId) return;
    const subscription = database
      .get<Attachment>("attachments")
      .query(Q.where("note_id", noteId))
      .observeWithColumns(["file_path", "file_size", "mime_type"])
      .subscribe({
        next: (rows) => setAttachments(rows.map(toSizeInfo)),
        // Sizes are a label only: a failed query leaves the cards without one.
        error: (err: unknown) => console.warn("[editor] attachment sizes unavailable", err),
      });
    return () => subscription.unsubscribe();
  }, [noteId]);

  return attachments;
}
