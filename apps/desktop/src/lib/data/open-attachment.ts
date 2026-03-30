import { Linking } from "react-native";

export interface OpenAttachmentParams {
  signedUrl: string | null;
  localUri: string | null;
  isPending: boolean;
}

export type OpenAttachmentResult = { status: "opened" } | { status: "unavailable"; reason: string };

export async function openAttachment({
  signedUrl,
  localUri,
  isPending,
}: OpenAttachmentParams): Promise<OpenAttachmentResult> {
  if (isPending) {
    if (!localUri) {
      return { status: "unavailable", reason: "File is still uploading" };
    }
    // On macOS, file:// URIs can be opened via Linking.openURL (opens in Finder/default app)
    try {
      const supported = await Linking.canOpenURL(localUri);
      if (!supported) {
        return { status: "unavailable", reason: "Cannot open this file type" };
      }
      await Linking.openURL(localUri);
      return { status: "opened" };
    } catch {
      return { status: "unavailable", reason: "Failed to open file" };
    }
  }

  if (!signedUrl) {
    return { status: "unavailable", reason: "Could not load attachment URL" };
  }

  // On macOS, open in default browser
  try {
    await Linking.openURL(signedUrl);
    return { status: "opened" };
  } catch {
    return { status: "unavailable", reason: "Failed to open attachment" };
  }
}
