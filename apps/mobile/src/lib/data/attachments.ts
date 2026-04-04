import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";

import { BUCKET_NAME, SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

import { supabase } from "@/lib/supabase";

interface PickedFile {
  uri: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
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
