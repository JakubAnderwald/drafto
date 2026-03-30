import { NativeModules } from "react-native";

import { MAX_FILE_SIZE, BUCKET_NAME, SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

import { supabase } from "@/lib/supabase";
import { sanitizeFileName } from "./attachment-utils";

const { RNDocumentPicker } = NativeModules;

export interface PickedFile {
  uri: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

interface UploadResult {
  id: string;
  noteId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
}

interface MacOSPickerResult {
  uri: string;
  path: string;
  name: string;
  size: number | null;
  mimeType: string | null;
}

async function pickFiles(allowedUTIs?: string[]): Promise<MacOSPickerResult[]> {
  const options: Record<string, unknown> = {
    allowFileSelection: true,
    allowDirectorySelection: false,
    multiple: false,
  };
  if (allowedUTIs) {
    options.allowedUTIs = allowedUTIs;
  }
  return RNDocumentPicker.pick(options) as Promise<MacOSPickerResult[]>;
}

export async function pickImage(): Promise<PickedFile | null> {
  try {
    const results = await pickFiles(["public.image"]);
    if (!results || results.length === 0) return null;

    const result = results[0];
    return {
      uri: result.uri,
      fileName: result.name ?? `image_${Date.now()}`,
      mimeType: result.mimeType ?? "application/octet-stream",
      fileSize: result.size ?? 0,
    };
  } catch (err) {
    if (isPickerCancelled(err)) return null;
    throw err;
  }
}

export async function pickDocument(): Promise<PickedFile | null> {
  try {
    const results = await pickFiles();
    if (!results || results.length === 0) return null;

    const result = results[0];
    return {
      uri: result.uri,
      fileName: result.name ?? `file_${Date.now()}`,
      mimeType: result.mimeType ?? "application/octet-stream",
      fileSize: result.size ?? 0,
    };
  } catch (err) {
    if (isPickerCancelled(err)) return null;
    throw err;
  }
}

function isPickerCancelled(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // react-native-document-picker-macos rejects with code "USER_CANCELLED"
  const errorWithCode = err as Error & { code?: string };
  return errorWithCode.code === "USER_CANCELLED" || err.message.includes("cancel");
}

export async function uploadAttachment(
  userId: string,
  noteId: string,
  file: PickedFile,
): Promise<UploadResult> {
  if (file.fileSize > MAX_FILE_SIZE) {
    throw new Error("File size exceeds 25MB limit");
  }

  const fileName = sanitizeFileName(file.fileName);
  const filePath = `${userId}/${noteId}/${fileName}`;

  // Read file as blob for upload
  const response = await fetch(file.uri);
  const blob = await response.blob();

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(filePath, blob, {
    contentType: file.mimeType,
    upsert: false,
  });

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`);
  }

  // Create attachment record in database
  const { data: attachment, error: dbError } = await supabase
    .from("attachments")
    .insert({
      note_id: noteId,
      user_id: userId,
      file_name: fileName,
      file_path: filePath,
      file_size: file.fileSize,
      mime_type: file.mimeType,
    })
    .select("id, note_id, file_name, file_path, file_size, mime_type")
    .single();

  if (dbError || !attachment) {
    // Clean up uploaded file if DB insert fails
    await supabase.storage.from(BUCKET_NAME).remove([filePath]);
    throw new Error(`Failed to save attachment record: ${dbError?.message ?? "Unknown error"}`);
  }

  return {
    id: attachment.id,
    noteId: attachment.note_id,
    fileName: attachment.file_name,
    filePath: attachment.file_path,
    fileSize: attachment.file_size,
    mimeType: attachment.mime_type,
  };
}

export async function getSignedUrl(filePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to get signed URL: ${error?.message ?? "Unknown error"}`);
  }

  return data.signedUrl;
}

export async function deleteAttachment(attachmentId: string, filePath: string): Promise<void> {
  // Delete from database first — orphaned storage is less problematic than orphaned DB records
  const { error } = await supabase.from("attachments").delete().eq("id", attachmentId);
  if (error) {
    throw new Error(`Failed to delete attachment: ${error.message}`);
  }

  // Delete from storage (best effort)
  const { error: storageError } = await supabase.storage.from(BUCKET_NAME).remove([filePath]);
  if (storageError) {
    console.warn(`Failed to delete storage object: ${storageError.message}`);
  }
}
