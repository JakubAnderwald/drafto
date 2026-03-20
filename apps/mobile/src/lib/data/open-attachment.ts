import { Platform, Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";

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
    // On Android, file:// URIs cannot be opened via Linking.openURL.
    // Use the system share/open mechanism via Linking with content:// URIs
    // is not straightforward, so we open pending files only on iOS.
    if (Platform.OS === "android") {
      return {
        status: "unavailable",
        reason: "File will be available after upload completes",
      };
    }
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

  try {
    await WebBrowser.openBrowserAsync(signedUrl, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
    });
    return { status: "opened" };
  } catch {
    // Fallback to Linking.openURL if in-app browser fails
    try {
      await Linking.openURL(signedUrl);
      return { status: "opened" };
    } catch {
      return { status: "unavailable", reason: "Failed to open attachment" };
    }
  }
}
