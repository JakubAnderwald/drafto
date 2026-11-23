import { Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";

/**
 * Opens a web page in the in-app browser, falling back to the system browser when the
 * in-app one fails. Resolves `true` once either opened, `false` when neither could, so the
 * caller can tell the user.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
    });
    return true;
  } catch {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  }
}
