import { Linking } from "react-native";

import { supabase } from "./supabase";

const REDIRECT_URL = "eu.drafto.desktop://auth/callback";

type OAuthProvider = "google" | "apple";

export async function signInWithOAuthBrowser(
  provider: OAuthProvider,
): Promise<{ error: string | null }> {
  try {
    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: REDIRECT_URL,
        skipBrowserRedirect: true,
      },
    });

    if (oauthError || !data.url) {
      return { error: oauthError?.message ?? "Failed to start sign-in." };
    }

    await Linking.openURL(data.url);
    return { error: null };
  } catch {
    return { error: "Failed to open sign-in. Please try again." };
  }
}

export function handleOAuthCallback(url: string): void {
  try {
    const parsed = new URL(url);

    if (!parsed.pathname.includes("auth/callback")) {
      return;
    }

    // Handle fragment-based tokens (implicit flow) or code-based (PKCE)
    const params = new URLSearchParams(parsed.hash ? parsed.hash.substring(1) : parsed.search);

    const code = params.get("code");
    if (code) {
      supabase.auth.exchangeCodeForSession(code).catch((err) => {
        console.error("[oauth] Failed to exchange code for session:", err);
      });
      return;
    }

    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    if (accessToken && refreshToken) {
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken })
        .catch((err) => {
          console.error("[oauth] Failed to set session:", err);
        });
    }
  } catch (err) {
    console.error("[oauth] Failed to parse callback URL:", err);
  }
}
