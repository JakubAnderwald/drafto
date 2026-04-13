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

export async function signInWithGoogle(): Promise<{ error: string | null }> {
  try {
    await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();

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
    return { error: "Google Sign-In failed. Please try again." };
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
