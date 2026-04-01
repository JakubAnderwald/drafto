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
  return name
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .slice(0, 255);
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

  const blob = new Blob([bytes], { type: attachment.mimeType });

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
  const pending = await database
    .get<Attachment>("attachments")
    .query(Q.where("upload_status", "pending"))
    .fetch();

  if (pending.length === 0) return { uploaded: 0, failed: 0 };

  let uploaded = 0;
  let failed = 0;

  for (const attachment of pending) {
    try {
      await uploadSingleAttachment(attachment);
      uploaded += 1;
    } catch (err) {
      failed += 1;
      // Log and continue with next attachment — will retry on next sync
      console.warn(`Failed to upload attachment ${attachment.fileName}:`, err);
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
