import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentSizeInfo } from "@drafto/shared";

interface AttachmentRow {
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
}

function isAttachmentRow(value: unknown): value is AttachmentRow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { file_path?: unknown }).file_path === "string"
  );
}

function toSizeInfo(row: AttachmentRow): AttachmentSizeInfo {
  return { filePath: row.file_path, fileSize: row.file_size, mimeType: row.mime_type };
}

export interface NoteAttachmentSizes {
  attachments: AttachmentSizeInfo[];
  /** Adds an attachment uploaded in this session, without fetching the list again. */
  addAttachment: (attachment: AttachmentSizeInfo) => void;
}

const NO_ATTACHMENTS: AttachmentSizeInfo[] = [];

interface LoadedSizes {
  noteId: string;
  attachments: AttachmentSizeInfo[];
}

/** `extra` added to `base`, replacing any entry of `base` for the same path. */
function mergeByPath(
  base: AttachmentSizeInfo[],
  extra: AttachmentSizeInfo[],
): AttachmentSizeInfo[] {
  const paths = new Set(extra.map((attachment) => attachment.filePath));
  return [...base.filter((attachment) => !paths.has(attachment.filePath)), ...extra];
}

/**
 * The path, size and type of each of the note's attachments, for the size
 * label on its file blocks (PrimeTestLab 11035 S-04). Fetched once per note;
 * uploads made here are added with `addAttachment`. A failed fetch only
 * leaves the labels out.
 */
export function useNoteAttachmentSizes(noteId: string): NoteAttachmentSizes {
  // Tagged with its note, so another note's list is never shown while the
  // new one loads.
  const [loaded, setLoaded] = useState<LoadedSizes>({ noteId, attachments: NO_ATTACHMENTS });
  // The note on show. An upload that finishes after the user moved to another note must not
  // replace that note's list with its own note's; it is fetched again when that note reopens.
  const activeNoteId = useRef(noteId);

  useEffect(() => {
    activeNoteId.current = noteId;
    let cancelled = false;
    fetch(`/api/notes/${noteId}/attachments`)
      .then(async (response) => {
        if (!response.ok) return;
        const rows: unknown = await response.json();
        if (cancelled || !Array.isArray(rows)) return;
        const fetched = rows.filter(isAttachmentRow).map(toSizeInfo);
        // An upload added while the list was loading is kept.
        setLoaded((current) => ({
          noteId,
          attachments:
            current.noteId === noteId ? mergeByPath(fetched, current.attachments) : fetched,
        }));
      })
      .catch((err: unknown) => {
        console.warn("[editor] attachment sizes unavailable", err);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const addAttachment = useCallback(
    (attachment: AttachmentSizeInfo) => {
      if (activeNoteId.current !== noteId) return;
      setLoaded((current) => ({
        noteId,
        attachments: mergeByPath(current.noteId === noteId ? current.attachments : [], [
          attachment,
        ]),
      }));
    },
    [noteId],
  );

  const attachments = loaded.noteId === noteId ? loaded.attachments : NO_ATTACHMENTS;
  return { attachments, addAttachment };
}
