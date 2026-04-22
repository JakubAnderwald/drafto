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
    // URL schemes are case-insensitive per RFC 3986 — normalize before match.
    if (!url.toLowerCase().startsWith("eu.drafto.desktop:")) {
      return;
    }

    const parsed = new URL(url);

    // Callbacks can arrive with params in the query string (PKCE) or the
    // hash fragment (implicit). WHATWG URL parses `auth` as the host for
    // non-special schemes, so do not gate on pathname — gate on scheme
    // above and on the presence of known auth params below.
    const searchParams = new URLSearchParams(parsed.search);
    const hashParams = new URLSearchParams(
      parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash,
    );

    // Log only non-sensitive metadata — never the raw URL, which carries
    // the OAuth code or access/refresh tokens.
    console.info("[oauth] handling callback", {
      hasQuery: !!parsed.search,
      hasHash: !!parsed.hash,
    });

    const code = searchParams.get("code") ?? hashParams.get("code");
    if (code) {
      supabase.auth.exchangeCodeForSession(code).catch((err) => {
        console.error("[oauth] Failed to exchange code for session:", err);
      });
      return;
    }

    const accessToken = searchParams.get("access_token") ?? hashParams.get("access_token");
    const refreshToken = searchParams.get("refresh_token") ?? hashParams.get("refresh_token");
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
