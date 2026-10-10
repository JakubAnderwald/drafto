import { Linking } from "react-native";

import { isRecoveryUrl } from "@/lib/auth-recovery";
import { apiUrl } from "@/lib/config";
import { supabase } from "@/lib/supabase";

/**
 * Supabase ends the OAuth redirect on this drafto.eu hand-off page, not on the
 * app's scheme: a redirect straight to `eu.drafto.desktop://` leaves the browser
 * tab frozen mid-navigation. The page forwards the code to
 * `eu.drafto.desktop://auth/callback`, which `handleOAuthCallback` consumes.
 * Must be allowlisted in Supabase Auth (ADR-0044).
 */
export const OAUTH_REDIRECT_URL = `${apiUrl}/auth/desktop/callback`;

type OAuthProvider = "google" | "apple";

export async function signInWithOAuthBrowser(
  provider: OAuthProvider,
): Promise<{ error: string | null }> {
  try {
    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: OAUTH_REDIRECT_URL,
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

/**
 * Codes this app run has already handed to `exchangeCodeForSession`. A code is
 * single-use, and the drafto.eu hand-off page sends the same link twice in the
 * normal case: once automatically and again from its "Open Drafto" button. A
 * second exchange would only fail ("PKCE code verifier not found").
 */
const exchangedCodes = new Set<string>();

/**
 * Finishes OAuth sign-in from an `eu.drafto.desktop://auth/callback` deep link.
 *
 * Only a PKCE `code` is accepted. The client runs `flowType: "pkce"`, so only
 * this install holds the `code_verifier` that redeems it. Implicit-flow
 * `access_token`/`refresh_token` params are deliberately ignored. Any website can
 * open `eu.drafto.desktop://auth/callback#access_token=…&refresh_token=…`, and
 * honouring those tokens with `setSession` would sign the app into an attacker's
 * account.
 */
export function handleOAuthCallback(url: string): void {
  try {
    // URL schemes are case-insensitive per RFC 3986 — normalize before match.
    if (!url.toLowerCase().startsWith("eu.drafto.desktop:")) {
      return;
    }

    // Password-recovery callbacks arrive over the same scheme but belong to
    // `auth-recovery.ts`. Exchanging the code here as well would burn it and
    // drop the user into a plain signed-in session instead of the reset screen.
    if (isRecoveryUrl(url)) {
      return;
    }

    const parsed = new URL(url);

    // WHATWG URL parses `auth` as the host for non-special schemes, so do not
    // gate on pathname — gate on scheme above and on the code below.
    const searchParams = new URLSearchParams(parsed.search);
    const hashParams = new URLSearchParams(
      parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash,
    );

    // Log only non-sensitive metadata — never the raw URL, which carries the code.
    console.info("[oauth] handling callback", {
      hasQuery: !!parsed.search,
      hasHash: !!parsed.hash,
    });

    const code = searchParams.get("code") ?? hashParams.get("code");
    if (!code || exchangedCodes.has(code)) {
      return;
    }

    exchangedCodes.add(code);
    supabase.auth.exchangeCodeForSession(code).catch((err) => {
      console.error("[oauth] Failed to exchange code for session:", err);
    });
  } catch (err) {
    console.error("[oauth] Failed to parse callback URL:", err);
  }
}
