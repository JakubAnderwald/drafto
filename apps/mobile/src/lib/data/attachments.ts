import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";

import { MAX_FILE_SIZE, BUCKET_NAME } from "@drafto/shared";

import { supabase } from "@/lib/supabase";

interface PickedFile {
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
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== "granted") {
    throw new Error("Permission to access photos was denied");
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.8,
    allowsMultipleSelection: false,
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    fileName: asset.fileName ?? `image_${Date.now()}.jpg`,
    mimeType: asset.mimeType ?? "image/jpeg",
    fileSize: asset.fileSize ?? 0,
  };
}

export async function pickDocument(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    fileName: asset.name,
    mimeType: asset.mimeType ?? "application/octet-stream",
    fileSize: asset.size ?? 0,
  };
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

export async function deleteAttachment(attachmentId: string, filePath: string): Promise<void> {
  // Delete from storage
  await supabase.storage.from(BUCKET_NAME).remove([filePath]);

  // Delete from database
  const { error } = await supabase.from("attachments").delete().eq("id", attachmentId);
  if (error) {
    throw new Error(`Failed to delete attachment: ${error.message}`);
  }
}
