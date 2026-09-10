import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as WebBrowser from "expo-web-browser";
import {
  GoogleSignin,
  isErrorWithCode,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import Constants from "expo-constants";

import { supabase } from "./supabase";

const googleWebClientId = Constants.expoConfig?.extra?.googleWebClientId as string;

/**
 * `String.valueOf(CommonStatusCodes.DEVELOPER_ERROR)` — the code the Android module rejects with
 * when the calling app is not registered as an Android-type OAuth client in the Cloud project
 * (client missing, or its signing-certificate SHA-1 does not match the installed build).
 * `statusCodes` does not expose it, so it has to be matched as a literal.
 */
const DEVELOPER_ERROR_CODE = "10";

/**
 * When `configure()` has not run, the Android module rejects with the native module NAME as the
 * code and this exact message — so this failure can only be recognised by its message.
 */
const UNCONFIGURED_CLIENT_MESSAGE = "apiClient is null - call configure() first";

export function configureGoogleSignIn() {
  if (!googleWebClientId) {
    console.warn("Missing EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID — Google Sign-In will not work");
    return;
  }
  GoogleSignin.configure({
    webClientId: googleWebClientId,
    iosClientId: Constants.expoConfig?.extra?.googleIosClientId as string | undefined,
  });
}

function nativeErrorDetails(err: unknown): { code: string | null; message: string } {
  const code = isErrorWithCode(err) ? err.code : null;
  const message =
    typeof err === "object" && err !== null && "message" in err && typeof err.message === "string"
      ? err.message
      : "";
  return { code, message };
}

/**
 * Turns a native Google Sign-In rejection into a message a user can act on — and that an operator
 * can diagnose from a screenshot. Every message carries the native status code verbatim, because
 * the code is what distinguishes a device problem from a Cloud-Console misconfiguration.
 */
export function describeGoogleSignInError(err: unknown): string {
  const { code, message } = nativeErrorDetails(err);

  if (code === DEVELOPER_ERROR_CODE || message.includes("DEVELOPER_ERROR")) {
    return (
      `Google Sign-In failed (code ${code ?? DEVELOPER_ERROR_CODE}): this build is not registered ` +
      `with Google. The Android OAuth client is missing, or its signing-certificate SHA-1 does not match.`
    );
  }

  if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
    return `Google Sign-In failed (code ${code}): Google Play services is unavailable or out of date on this device.`;
  }

  if (message === UNCONFIGURED_CLIENT_MESSAGE) {
    const codeSuffix = code ? ` (code ${code})` : "";
    return `Google Sign-In failed${codeSuffix}: the Google client was not configured. Restart the app and try again.`;
  }

  if (code) {
    return `Google Sign-In failed (code ${code}). Please try again.`;
  }

  return "Google Sign-In failed. Please try again.";
}

export async function signInWithGoogle(): Promise<{ error: string | null }> {
  try {
    await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();

    // v16 resolves `{ type: "cancelled", data: null }` rather than throwing when the user dismisses
    // the sheet, so cancellation has to be caught here — never as an error banner.
    if (response.type === "cancelled") {
      return { error: null };
    }

    if (!response.data?.idToken) {
      return { error: "Google Sign-In did not return an ID token." };
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: "google",
      token: response.data.idToken,
    });

    if (error) {
      return { error: error.message };
    }

    return { error: null };
  } catch (err) {
    if (isErrorWithCode(err)) {
      if (err.code === statusCodes.SIGN_IN_CANCELLED || err.code === statusCodes.IN_PROGRESS) {
        return { error: null };
      }
    }

    // Stable, greppable prefix so `adb logcat -s ReactNativeJS:V` surfaces the native code on a
    // release build without needing a debugger attached.
    const { code, message } = nativeErrorDetails(err);
    console.warn("[oauth][google] sign-in failed", { code, message });

    return { error: describeGoogleSignInError(err) };
  }
}

export async function signInWithApple(): Promise<{ error: string | null }> {
  if (Platform.OS === "ios") {
    return signInWithAppleNative();
  }
  return signInWithAppleBrowser();
}

async function signInWithAppleNative(): Promise<{ error: string | null }> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });

    if (!credential.identityToken) {
      return { error: "Apple Sign-In did not return an identity token." };
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: "apple",
      token: credential.identityToken,
    });

    if (error) {
      return { error: error.message };
    }

    return { error: null };
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_REQUEST_CANCELED") {
      return { error: null };
    }
    return { error: "Apple Sign-In failed. Please try again." };
  }
}

async function signInWithAppleBrowser(): Promise<{ error: string | null }> {
  try {
    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "apple",
      options: {
        redirectTo: "drafto://auth/callback",
        skipBrowserRedirect: true,
      },
    });

    if (oauthError || !data.url) {
      return { error: oauthError?.message ?? "Failed to start Apple Sign-In." };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, "drafto://auth/callback");

    if (result.type === "success" && result.url) {
      const url = new URL(result.url);
      const code = url.searchParams.get("code");

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          return { error: error.message };
        }
        return { error: null };
      }
    }

    // User cancelled or dismissed
    return { error: null };
  } catch {
    return { error: "Apple Sign-In failed. Please try again." };
  }
}
