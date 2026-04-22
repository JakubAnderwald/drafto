import RNFS from "react-native-fs";
import { Q } from "@nozbe/watermelondb";

import { MAX_FILE_SIZE, BUCKET_NAME } from "@drafto/shared";

import { database, Attachment } from "@/db";
import { supabase } from "@/lib/supabase";
import { generateId } from "@/lib/generate-id";
import { sanitizeFileName } from "./attachment-utils";
import type { PickedFile } from "./attachments";

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

  const localFileName = `${generateId()}_${sanitizeFileName(file.fileName)}`;
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
    throw new Error("File size exceeds 25MB limit");
  }

  const fileName = sanitizeFileName(file.fileName);
  const filePath = `${userId}/${noteId}/${fileName}`;
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
    await RNFS.unlink(localPath);
  } catch {
    // Non-critical: local file cleanup can fail silently
  }
}

let isProcessing = false;

export async function processPendingUploads(): Promise<number> {
  if (isProcessing) {
    return 0;
  }
  isProcessing = true;

  try {
    // Retry both pending and previously failed uploads so a transient error
    // doesn't strand an attachment forever.
    const queued = await database
      .get<Attachment>("attachments")
      .query(Q.where("upload_status", Q.oneOf(["pending", "failed"])))
      .fetch();

    if (queued.length === 0) return 0;

    let uploaded = 0;

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

    return uploaded;
  } finally {
    isProcessing = false;
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
