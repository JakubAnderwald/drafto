import { File, Directory, Paths } from "expo-file-system";
import { Q } from "@nozbe/watermelondb";

import { MAX_FILE_SIZE, BUCKET_NAME, FILE_TOO_LARGE_MESSAGE } from "@drafto/shared";

import { database, Attachment } from "@/db";
import { supabase } from "@/lib/supabase";
import { generateId } from "@/lib/generate-id";

interface PickedFile {
  uri: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

const ATTACHMENTS_DIR_NAME = "attachments";

function sanitizeFileName(name: string): string {
  return (
    name
      // Decompose combining marks so accented chars become base + mark (e.g. "ö" → "o" + U+0308),
      // then strip the marks. Supabase Storage rejects non-ASCII keys; this lossy normalisation
      // preserves the readable base letter instead of falling back to an underscore.
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      // Any remaining non-printable-ASCII (emoji, CJK, control chars) becomes "_"
      .replace(/[^\x20-\x7e]/g, "_")
      // Filesystem-unsafe ASCII chars
      .replace(/[/\\<>:"|?*]/g, "_")
      // Path traversal
      .replace(/\.\./g, "_")
      .slice(0, 255)
  );
}

function getAttachmentsDir(): Directory {
  return new Directory(Paths.document, ATTACHMENTS_DIR_NAME);
}

function saveFileLocally(file: PickedFile): string {
  const dir = getAttachmentsDir();
  if (!dir.exists) {
    dir.create();
  }
  const localFileName = `${generateId()}_${sanitizeFileName(file.fileName)}`;
  const source = new File(file.uri);
  const destination = new File(dir, localFileName);
  source.copy(destination);

  if (!destination.exists || destination.size === 0) {
    throw new Error("File copy failed — destination is missing or empty");
  }

  return destination.uri;
}

export async function queueAttachment(
  userId: string,
  noteId: string,
  file: PickedFile,
): Promise<Attachment> {
  if (file.fileSize > MAX_FILE_SIZE) {
    throw new Error(FILE_TOO_LARGE_MESSAGE);
  }

  const fileName = sanitizeFileName(file.fileName);
  const filePath = `${userId}/${noteId}/${fileName}`;
  const localUri = saveFileLocally(file);
  const remoteId = generateId();

  const attachment = await database.write(async () => {
    return database.get<Attachment>("attachments").create((record) => {
      record._raw.id = remoteId;
      record.remoteId = remoteId;
      record.noteId = noteId;
      record.userId = userId;
      record.fileName = fileName;
      record.filePath = filePath;
      record.fileSize = file.fileSize;
      record.mimeType = file.mimeType;
      record.localUri = localUri;
      record.uploadStatus = "pending";
      record.uploadError = null;
    });
  });

  return attachment;
}

async function uploadSingleAttachment(attachment: Attachment): Promise<void> {
  const localUri = attachment.localUri;
  if (!localUri) {
    throw new Error("No local file to upload");
  }

  const localFile = new File(localUri);
  if (!localFile.exists) {
    throw new Error("Local file not found");
  }

  // Read file bytes natively via expo-file-system — React Native's fetch()
  // with file:// URIs can produce empty blobs on Android.
  const bytes = await localFile.bytes();

  if (bytes.length === 0) {
    throw new Error("Local file is empty — skipping upload");
  }

  // Pass Uint8Array directly — Blob does not work reliably in React Native
  // on Android (documented supabase-js limitation).
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(attachment.filePath, bytes, {
      contentType: attachment.mimeType,
      upsert: false,
    });

  if (uploadError) {
    // If file already exists (e.g. retry after partial success), treat as success
    if (!uploadError.message.includes("already exists")) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }
  }

  // Create attachment record in Supabase. ON CONFLICT DO NOTHING: a retry
  // after a partial success (row inserted, local status not yet updated) finds
  // the row already there, and public.attachments has no UPDATE policy, so a
  // plain upsert's ON CONFLICT DO UPDATE would be rejected by RLS and strand
  // the attachment as "failed" forever.
  const { error: dbError } = await supabase.from("attachments").upsert(
    {
      id: attachment.remoteId,
      note_id: attachment.noteId,
      user_id: attachment.userId,
      file_name: attachment.fileName,
      file_path: attachment.filePath,
      file_size: attachment.fileSize,
      mime_type: attachment.mimeType,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );

  if (dbError) {
    throw new Error(`Failed to save attachment record: ${dbError.message}`);
  }

  // Mark as uploaded and clear local URI
  await database.write(async () => {
    await attachment.update((record) => {
      record.uploadStatus = "uploaded";
      record.uploadError = null;
      record.localUri = null;
    });
  });

  // Clean up local file after successful upload
  try {
    localFile.delete();
  } catch {
    // Non-critical: local file cleanup can fail silently
  }
}

export interface UploadResult {
  uploaded: number;
  failed: number;
}

export async function processPendingUploads(): Promise<UploadResult> {
  // Retry both pending and previously failed uploads so a transient error
  // doesn't strand an attachment forever.
  const queued = await database
    .get<Attachment>("attachments")
    .query(Q.where("upload_status", Q.oneOf(["pending", "failed"])))
    .fetch();

  if (queued.length === 0) return { uploaded: 0, failed: 0 };

  let uploaded = 0;
  let failed = 0;

  for (const attachment of queued) {
    // uploadAttachment flips a failed row back to "pending" itself.
    if (await uploadAttachment(attachment)) {
      uploaded += 1;
    } else {
      failed += 1;
    }
  }

  return { uploaded, failed };
}

// One upload per attachment at a time. The editor uploads a freshly picked file
// straight away, while a sync started meanwhile (e.g. by the note write) drains
// the same queue; without this both would upload the file, and the second could
// find the local copy already deleted by the first and mark it failed.
const uploadsInFlight = new Map<string, Promise<boolean>>();

/**
 * Upload one queued attachment now and report whether it reached the server.
 * An upload error is recorded on the row (status "failed" plus the message) and
 * reported as `false` rather than thrown, so the next `processPendingUploads`
 * retries it. A call made while the same attachment is already uploading shares
 * that attempt.
 */
export function uploadAttachment(attachment: Attachment): Promise<boolean> {
  // A sync can fetch the queue while a direct upload is still running and reach
  // this attachment after that upload has finished. The upload deleted the
  // local copy, so trying again would fail and mark an uploaded file "failed".
  // (WatermelonDB hands out one cached instance per record, so the status read
  // here is current.)
  if (attachment.uploadStatus === "uploaded") return Promise.resolve(true);

  const running = uploadsInFlight.get(attachment.id);
  if (running) return running;

  const attempt = (async () => {
    try {
      // A retry flips a failed row back to "pending" (and clears its error) so
      // the UI reads "Pending" while it runs. The reset happens inside the
      // attempt, and the status is re-read inside the writer, so it always lands
      // before this attempt's own success write. Decided outside the attempt,
      // with the writer busy, it could queue behind a concurrent upload's
      // success write and turn an uploaded row back to "pending" with its local
      // file already gone.
      if (attachment.uploadStatus === "failed") {
        await database.write(async () => {
          if (attachment.uploadStatus !== "failed") return;
          await attachment.update((record) => {
            record.uploadStatus = "pending";
            record.uploadError = null;
          });
        });
      }

      await uploadSingleAttachment(attachment);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to upload attachment ${attachment.fileName}:`, err);
      await database.write(async () => {
        await attachment.update((record) => {
          record.uploadStatus = "failed";
          record.uploadError = message;
        });
      });
      return false;
    }
  })().finally(() => {
    uploadsInFlight.delete(attachment.id);
  });

  uploadsInFlight.set(attachment.id, attempt);
  return attempt;
}

/**
 * Delete the entire local attachments directory (and every cached file in it).
 * Used on sign-out and on the cross-account identity guard so one account's
 * downloaded/queued attachment files can't leak to the next account on the
 * device. Best-effort: a deletion failure is logged and swallowed so it never
 * blocks sign-out.
 */
export async function deleteAllLocalAttachments(): Promise<void> {
  try {
    const dir = getAttachmentsDir();
    if (dir.exists) {
      dir.delete();
    }
  } catch (error) {
    console.warn("Failed to delete local attachments directory:", error);
  }
}

export function cleanupOrphanedFiles(): void {
  try {
    const dir = getAttachmentsDir();
    if (!dir.exists) return;

    // Cleanup runs asynchronously — fire and forget
    database
      .get<Attachment>("attachments")
      .query(Q.where("upload_status", "pending"))
      .fetch()
      .then((pending) => {
        const pendingUris = new Set(pending.map((a) => a.localUri));

        for (const item of dir.list()) {
          if (!pendingUris.has(item.uri)) {
            try {
              item.delete();
            } catch {
              // Non-critical
            }
          }
        }
      })
      .catch(() => {
        // Non-critical cleanup
      });
  } catch {
    // Non-critical cleanup
  }
}
