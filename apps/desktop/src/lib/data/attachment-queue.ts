import RNFS from "react-native-fs";
import { Q } from "@nozbe/watermelondb";

import { MAX_FILE_SIZE, BUCKET_NAME } from "@drafto/shared";

import { database, Attachment } from "@/db";
import { supabase } from "@/lib/supabase";
import { generateId } from "@/lib/generate-id";
import type { PickedFile } from "./attachments";

const ATTACHMENTS_DIR_NAME = "attachments";

function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .slice(0, 255);
}

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

  // react-native-document-picker provides file:// URIs on macOS
  const sourcePath = file.uri.startsWith("file://") ? file.uri.slice(7) : file.uri;
  await RNFS.copyFile(sourcePath, destination);

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
    });
  });

  return attachment;
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

  // Read file as a Blob via fetch
  const fetchResponse = await fetch(localUri);
  const blob = await fetchResponse.blob();

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(attachment.filePath, blob, {
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

export async function processPendingUploads(): Promise<number> {
  const pending = await database
    .get<Attachment>("attachments")
    .query(Q.where("upload_status", "pending"))
    .fetch();

  if (pending.length === 0) return 0;

  let uploaded = 0;

  for (const attachment of pending) {
    try {
      await uploadSingleAttachment(attachment);
      uploaded += 1;
    } catch (err) {
      // Log and continue with next attachment — will retry on next sync
      console.warn(`Failed to upload attachment ${attachment.fileName}:`, err);
    }
  }

  return uploaded;
}

export async function cleanupOrphanedFiles(): Promise<void> {
  try {
    const dir = getAttachmentsDir();
    const exists = await RNFS.exists(dir);
    if (!exists) return;

    const pending = await database
      .get<Attachment>("attachments")
      .query(Q.where("upload_status", "pending"))
      .fetch();

    const pendingUris = new Set(pending.map((a) => a.localUri));
    const items = await RNFS.readDir(dir);

    for (const item of items) {
      const fileUri = `file://${item.path}`;
      if (!pendingUris.has(fileUri)) {
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
