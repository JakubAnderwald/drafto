import { pick, types } from "react-native-document-picker";

import { MAX_FILE_SIZE, BUCKET_NAME, SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

import { supabase } from "@/lib/supabase";

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

function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .slice(0, 255);
}

export async function pickImage(): Promise<PickedFile | null> {
  try {
    const [result] = await pick({
      type: [types.images],
      allowMultiSelection: false,
    });

    if (!result) return null;

    return {
      uri: result.uri,
      fileName: result.name ?? `image_${Date.now()}.jpg`,
      mimeType: result.type ?? "image/jpeg",
      fileSize: result.size ?? 0,
    };
  } catch (err) {
    // User cancelled the picker
    if (isPickerCancelled(err)) return null;
    throw err;
  }
}

export async function pickDocument(): Promise<PickedFile | null> {
  try {
    const [result] = await pick({
      type: [types.allFiles],
      allowMultiSelection: false,
    });

    if (!result) return null;

    return {
      uri: result.uri,
      fileName: result.name ?? `file_${Date.now()}`,
      mimeType: result.type ?? "application/octet-stream",
      fileSize: result.size ?? 0,
    };
  } catch (err) {
    if (isPickerCancelled(err)) return null;
    throw err;
  }
}

function isPickerCancelled(err: unknown): boolean {
  // react-native-document-picker throws when user cancels
  return err instanceof Error && (err.message.includes("cancel") || err.message.includes("Cancel"));
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
  // Delete from storage
  await supabase.storage.from(BUCKET_NAME).remove([filePath]);

  // Delete from database
  const { error } = await supabase.from("attachments").delete().eq("id", attachmentId);
  if (error) {
    throw new Error(`Failed to delete attachment: ${error.message}`);
  }
}
