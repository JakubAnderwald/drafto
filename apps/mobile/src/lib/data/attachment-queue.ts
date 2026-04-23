import { File, Directory, Paths } from "expo-file-system";
import { Q } from "@nozbe/watermelondb";

import { MAX_FILE_SIZE, BUCKET_NAME } from "@drafto/shared";

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
    throw new Error("File size exceeds 25MB limit");
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

  // Create attachment record in Supabase
  const { error: dbError } = await supabase.from("attachments").upsert({
    id: attachment.remoteId,
    note_id: attachment.noteId,
    user_id: attachment.userId,
    file_name: attachment.fileName,
    file_path: attachment.filePath,
    file_size: attachment.fileSize,
    mime_type: attachment.mimeType,
  });

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

    try {
      await uploadSingleAttachment(attachment);
      uploaded += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to upload attachment ${attachment.fileName}:`, err);
      await database.write(async () => {
        await attachment.update((record) => {
          record.uploadStatus = "failed";
          record.uploadError = message;
        });
      });
    }
  }

  return { uploaded, failed };
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
