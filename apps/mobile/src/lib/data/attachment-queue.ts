import { File, Directory, Paths } from "expo-file-system";
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
  storageFullMessage,
  wouldExceedQuota,
} from "@drafto/shared";
import type { StorageUsage } from "@drafto/shared";

import { database, Attachment } from "@/db";
import { supabase } from "@/lib/supabase";
import { generateId } from "@/lib/generate-id";
import { fetchStorageUsage } from "@/lib/data/storage-usage";

interface PickedFile {
  uri: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

const ATTACHMENTS_DIR_NAME = "attachments";

function getAttachmentsDir(): Directory {
  return new Directory(Paths.document, ATTACHMENTS_DIR_NAME);
}

function saveFileLocally(file: PickedFile): string {
  const dir = getAttachmentsDir();
  if (!dir.exists) {
    dir.create();
  }
  const localFileName = localAttachmentFileName(generateId(), file.fileName);
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

  // The key gets a unique suffix so two files with the same (sanitized) name on
  // one note never share an object; the display name stays without it.
  const fileName = safeAttachmentFileName(file.fileName);
  const { filePath } = buildAttachmentStoragePath(file.fileName, userId, noteId);
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

/**
 * Whether a storage upload error is the attachments bucket policy refusing it
 * (a 403 / "row-level security"). Since issue #794 that policy also refuses an
 * upload once the user's storage is full, so the caller re-reads the usage to
 * tell a quota refusal from any other policy failure.
 */
function isStoragePolicyRefusal(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const { statusCode, status, message } = error as {
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
  };
  return (
    statusCode === "403" ||
    statusCode === 403 ||
    status === 403 ||
    (typeof message === "string" && message.includes("row-level security"))
  );
}

/**
 * Refuse an upload for the storage quota (issue #794), unless this is a retry
 * whose row already reached the server. That row already counts in `usage`, and
 * rows are only inserted after their object uploaded, so the attachment is
 * complete: this returns normally and the caller marks it uploaded without
 * uploading again. Otherwise it throws a `StorageQuotaError`. A failed row check
 * throws a transient error instead, so the upload is retried, not given up on.
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

  await uploadFileAndRecord(attachment, bytes);

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

/**
 * Upload the file, then insert its row. Returns early, uploading nothing, when a
 * quota check finds the row already on the server (see `refuseForQuota`).
 */
async function uploadFileAndRecord(attachment: Attachment, bytes: Uint8Array): Promise<void> {
  // Pre-check the storage quota (issue #794), so a full account doesn't upload
  // bytes only for the server to refuse them. Unknown usage (offline, an older
  // server) skips the check; the database enforces the quota either way.
  const usage = await fetchStorageUsage();
  if (usage && wouldExceedQuota(usage, attachment.fileSize)) {
    await refuseForQuota(attachment, usage);
    return;
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
      // The bucket policy refuses uploads once storage is full. Only a fresh
      // usage reading that confirms it makes this a quota refusal; any other
      // refusal stays a transient failure, retried as before.
      if (isStoragePolicyRefusal(uploadError)) {
        const current = await fetchStorageUsage();
        if (current && wouldExceedQuota(current, attachment.fileSize)) {
          await refuseForQuota(attachment, current);
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
    // The quota trigger only raises when no row with this id exists yet, so
    // this attachment's row is known not to be on the server.
    if (isStorageQuotaError(dbError)) {
      throw new StorageQuotaError(await fetchStorageUsage());
    }
    throw new Error(`Failed to save attachment record: ${dbError.message}`);
  }
}

export interface UploadResult {
  uploaded: number;
  failed: number;
  /** Refused for the storage quota (issue #794): now "quota_exceeded", not retried. */
  storageFull: number;
}

export async function processPendingUploads(): Promise<UploadResult> {
  // Retry both pending and previously failed uploads so a transient error
  // doesn't strand an attachment forever. "quota_exceeded" is left out: the
  // server refused it for the storage quota, and retrying won't change that.
  const queued = await database
    .get<Attachment>("attachments")
    .query(Q.where("upload_status", Q.oneOf(["pending", "failed"])))
    .fetch();

  if (queued.length === 0) return { uploaded: 0, failed: 0, storageFull: 0 };

  let uploaded = 0;
  let failed = 0;
  let storageFull = 0;

  for (const attachment of queued) {
    // uploadAttachment flips a failed row back to "pending" itself.
    if (await uploadAttachment(attachment)) {
      uploaded += 1;
    } else if (attachment.uploadStatus === "quota_exceeded") {
      storageFull += 1;
    } else {
      failed += 1;
    }
  }

  return { uploaded, failed, storageFull };
}

/**
 * Record a quota refusal (issue #794) as the terminal "quota_exceeded" status,
 * with the storage-full message. The row is known not to be on the server, so
 * an object an earlier attempt uploaded is an orphan nothing else sweeps:
 * remove it, best effort.
 */
async function recordStorageFull(attachment: Attachment, err: unknown): Promise<void> {
  const message = err instanceof StorageQuotaError ? err.message : storageFullMessage(null, null);
  console.warn(`Attachment ${attachment.fileName} refused: storage quota exceeded`);
  try {
    await supabase.storage.from(BUCKET_NAME).remove([attachment.filePath]);
  } catch {
    // Best effort: a leftover object only takes space, and no row references it.
  }
  await database.write(async () => {
    await attachment.update((record) => {
      record.uploadStatus = "quota_exceeded";
      record.uploadError = message;
    });
  });
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
 * retries it. A refusal for the storage quota (issue #794) is reported as
 * `false` too, but recorded as "quota_exceeded" with the storage-full message
 * and not retried: callers tell the two apart by `attachment.isStorageFull`. A
 * call made while the same attachment is already uploading shares that attempt.
 */
export function uploadAttachment(attachment: Attachment): Promise<boolean> {
  // A sync can fetch the queue while a direct upload is still running and reach
  // this attachment after that upload has finished. The upload deleted the
  // local copy, so trying again would fail and mark an uploaded file "failed".
  // (WatermelonDB hands out one cached instance per record, so the status read
  // here is current.)
  if (attachment.uploadStatus === "uploaded") return Promise.resolve(true);
  // Refused for the storage quota (issue #794) by an attempt that has already
  // finished: terminal, so a sync that fetched the queue earlier mustn't retry it.
  if (attachment.uploadStatus === "quota_exceeded") return Promise.resolve(false);

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
      if (isStorageQuotaError(err)) {
        await recordStorageFull(attachment, err);
        return false;
      }
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
