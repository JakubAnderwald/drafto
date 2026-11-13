import RNFS from "react-native-fs";
import { Q } from "@nozbe/watermelondb";

import {
  MAX_FILE_SIZE,
  BUCKET_NAME,
  FILE_TOO_LARGE_MESSAGE,
  StorageQuotaError,
  buildAttachmentStoragePath,
  isStorageQuotaError,
  localAttachmentFileName,
  safeAttachmentFileName,
  wouldExceedQuota,
} from "@drafto/shared";
import type { StorageUsage } from "@drafto/shared";

import { database, Attachment } from "@/db";
import { supabase } from "@/lib/supabase";
import { generateId } from "@/lib/generate-id";
import type { PickedFile } from "./attachments";
import { fetchStorageUsage } from "@/lib/data/storage-usage";

/** What one processPendingUploads() run did. */
export interface UploadResult {
  /** Attachments uploaded (or found already on the server) this run. */
  uploaded: number;
  /** Attachments refused for the user's storage quota: now "quota_exceeded", never retried. */
  storageFull: number;
}

const ATTACHMENTS_DIR_NAME = "attachments";

function getAttachmentsDir(): string {
  return `${RNFS.DocumentDirectoryPath}/${ATTACHMENTS_DIR_NAME}`;
}

async function saveFileLocally(file: PickedFile): Promise<string> {
  const dir = getAttachmentsDir();
  const exists = await RNFS.exists(dir);
  if (!exists) {
    await RNFS.mkdir(dir);
  }

  const localFileName = localAttachmentFileName(generateId(), file.fileName);
  const destination = `${dir}/${localFileName}`;

  // Use the decoded POSIX path from the native picker — `file.uri` is a
  // percent-encoded file:// URL (e.g. macOS NFD-decomposed ö becomes %CC%88),
  // which RNFS.copyFile cannot resolve as a filesystem path.
  await RNFS.copyFile(file.path, destination);

  return `file://${destination}`;
}

export async function queueAttachment(
  userId: string,
  noteId: string,
  file: PickedFile,
): Promise<Attachment> {
  if (file.fileSize > MAX_FILE_SIZE) {
    throw new Error(FILE_TOO_LARGE_MESSAGE);
  }

  // The key gets a unique suffix so two files with the same (sanitized) name on
  // one note never share an object; the display name stays without it.
  const fileName = safeAttachmentFileName(file.fileName);
  const { filePath } = buildAttachmentStoragePath(file.fileName, userId, noteId);
  const localUri = await saveFileLocally(file);
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

function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function uploadSingleAttachment(attachment: Attachment): Promise<void> {
  const localUri = attachment.localUri;
  if (!localUri) {
    throw new Error("No local file to upload");
  }

  const localPath = localUri.startsWith("file://") ? localUri.slice(7) : localUri;
  const exists = await RNFS.exists(localPath);
  if (!exists) {
    throw new Error("Local file not found");
  }

  // Read file bytes natively via RNFS — React Native's fetch() with file://
  // URIs can produce empty or truncated blobs for larger files on macOS.
  const base64 = await RNFS.readFile(localPath, "base64");
  const bytes = base64ToBytes(base64);

  if (bytes.length === 0) {
    throw new Error("Local file is empty — skipping upload");
  }

  // Storage quota pre-check (issue #794): an upload that can't fit is refused here,
  // before its bytes go out. Unknown usage (offline, an older server) skips the check;
  // the database enforces the quota either way.
  const usage = await fetchStorageUsage();
  if (usage && wouldExceedQuota(usage, attachment.fileSize)) {
    // Returns only when this attachment's row is already on the server (a retry after
    // a partial success): its object is there too, so there is nothing left to store.
    await refuseForQuota(attachment, usage);
  } else {
    await storeAttachment(attachment, bytes);
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
    await RNFS.unlink(localPath);
  } catch {
    // Non-critical: local file cleanup can fail silently
  }
}

/**
 * Whether a storage upload error is the bucket's row-level-security refusal, which is
 * how the storage API answers an upload over the quota (`can_store_attachment()`).
 */
function isRowLevelSecurityRefusal(error: { message: string }): boolean {
  const { statusCode, status } = error as unknown as { statusCode?: string; status?: number };
  return statusCode === "403" || status === 403 || error.message.includes("row-level security");
}

/**
 * Refuses an upload for the storage quota. A retry after a partial success may already
 * have its row on the server (counted in `usage`), so this returns normally when the row
 * exists: rows are only inserted after the upload, so the object is there too and the
 * caller marks the attachment uploaded. A failed row check throws a transient error, so
 * the attachment retries instead of being marked terminal.
 */
async function refuseForQuota(attachment: Attachment, usage: StorageUsage): Promise<void> {
  const { data, error } = await supabase
    .from("attachments")
    .select("id")
    .eq("id", attachment.remoteId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to check attachment record: ${error.message}`);
  }
  if (data) return;
  throw new StorageQuotaError(usage);
}

/** Uploads the attachment's object, then inserts its row. */
async function storeAttachment(attachment: Attachment, bytes: Uint8Array): Promise<void> {
  // Pass Uint8Array directly — Blob does not work reliably in React Native
  // (documented supabase-js limitation).
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(attachment.filePath, bytes, {
      contentType: attachment.mimeType,
      upsert: false,
    });

  if (uploadError) {
    // If file already exists (e.g. retry after partial success), treat as success.
    // Check both message and status code for robustness.
    const isDuplicate =
      uploadError.message.includes("already exists") ||
      uploadError.message.includes("Duplicate") ||
      (uploadError as unknown as { statusCode?: string }).statusCode === "409";
    if (!isDuplicate) {
      // The storage policy refuses an upload over the quota with an RLS error. Only a
      // fresh usage reading that confirms it makes this terminal; any other refusal (or
      // unknown usage) stays a transient failure and retries.
      if (isRowLevelSecurityRefusal(uploadError)) {
        const usage = await fetchStorageUsage();
        if (usage && wouldExceedQuota(usage, attachment.fileSize)) {
          // Returns only when the row (and so the object) is already on the server.
          await refuseForQuota(attachment, usage);
          return;
        }
      }
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
    // The attachments trigger refuses a row over the quota with
    // "storage_quota_exceeded". It only raises when no row with this id exists, so
    // the refusal is final for this attachment.
    if (isStorageQuotaError(dbError)) {
      throw new StorageQuotaError(await fetchStorageUsage());
    }
    throw new Error(`Failed to save attachment record: ${dbError.message}`);
  }
}

/**
 * Best-effort removal of the object a refused attachment's row would have pointed at
 * (the row is known not to exist). Storage reports most failures in its result rather
 * than throwing, so both are checked and logged. The refusal stands either way: a
 * leftover object stays under its note, counted in the bucket policy's object term but
 * not in usage, until the note is deleted and the server's orphan sweep removes it.
 */
async function removeRefusedObject(attachment: Attachment): Promise<void> {
  try {
    const { error } = await supabase.storage.from(BUCKET_NAME).remove([attachment.filePath]);
    if (error) {
      console.warn(`Failed to remove refused attachment ${attachment.fileName}:`, error);
    }
  } catch (err) {
    console.warn(`Failed to remove refused attachment ${attachment.fileName}:`, err);
  }
}

/**
 * Uploads one queued attachment and records the outcome on it. Returns false when it
 * failed; the caller tells a quota refusal (`attachment.isStorageFull`) from a
 * transient failure.
 */
async function uploadQueuedAttachment(attachment: Attachment): Promise<boolean> {
  try {
    await uploadSingleAttachment(attachment);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isStorageQuotaError(err)) {
      await removeRefusedObject(attachment);
      // Terminal: processPendingUploads only retries "pending" / "failed".
      await database.write(async () => {
        await attachment.update((record) => {
          record.uploadStatus = "quota_exceeded";
          record.uploadError = message;
        });
      });
      return false;
    }
    console.warn(`Failed to upload attachment ${attachment.fileName}:`, err);
    await database.write(async () => {
      await attachment.update((record) => {
        record.uploadStatus = "failed";
        record.uploadError = message;
      });
    });
    return false;
  }
}

let isProcessing = false;

export async function processPendingUploads(): Promise<UploadResult> {
  if (isProcessing) {
    return { uploaded: 0, storageFull: 0 };
  }
  isProcessing = true;

  try {
    // Retry both pending and previously failed uploads so a transient error
    // doesn't strand an attachment forever.
    const queued = await database
      .get<Attachment>("attachments")
      .query(Q.where("upload_status", Q.oneOf(["pending", "failed"])))
      .fetch();

    if (queued.length === 0) return { uploaded: 0, storageFull: 0 };

    let uploaded = 0;
    let storageFull = 0;

    for (const attachment of queued) {
      try {
        // Flip back to "pending" (and clear any prior error) so the UI reads
        // "Pending" during the retry attempt rather than "Failed".
        if (attachment.uploadStatus === "failed") {
          await database.write(async () => {
            await attachment.update((record) => {
              record.uploadStatus = "pending";
              record.uploadError = null;
            });
          });
        }

        if (await uploadQueuedAttachment(attachment)) {
          uploaded += 1;
        } else if (attachment.uploadStatus === "quota_exceeded") {
          storageFull += 1;
        }
      } catch (err) {
        // A local write for this attachment failed, so it stays queued for the next run.
        // The rest of the queue still goes, and the counts so far survive: a quota
        // refusal already recorded must still reach the caller, which reports it.
        console.warn(`Failed to process queued attachment ${attachment.fileName}:`, err);
      }
    }

    return { uploaded, storageFull };
  } finally {
    isProcessing = false;
  }
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
    const exists = await RNFS.exists(dir);
    if (exists) {
      await RNFS.unlink(dir);
    }
  } catch (error) {
    console.warn("Failed to delete local attachments directory:", error);
  }
}

export async function cleanupOrphanedFiles(): Promise<void> {
  try {
    const dir = getAttachmentsDir();
    const exists = await RNFS.exists(dir);
    if (!exists) return;

    // Query all attachments that have a local URI (not just pending)
    const withLocalUri = await database
      .get<Attachment>("attachments")
      .query(Q.where("local_uri", Q.notEq(null)))
      .fetch();

    const activeUris = new Set(withLocalUri.map((a) => a.localUri));
    const items = await RNFS.readDir(dir);

    for (const item of items) {
      const fileUri = `file://${item.path}`;
      if (!activeUris.has(fileUri)) {
        try {
          await RNFS.unlink(item.path);
        } catch {
          // Non-critical
        }
      }
    }
  } catch {
    // Non-critical cleanup
  }
}
