import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import { Platform } from "react-native";

import type { Database, DraftoClientTag } from "@drafto/shared";

import { installCryptoDigest } from "@/lib/crypto-digest";
import { installCryptoRandom } from "@/lib/crypto-random";
import { secureStoreAdapter } from "./secure-store-adapter";

// Before any auth call: supabase-js draws the PKCE `code_verifier` from
// `crypto.getRandomValues`, and hashes it into an S256 challenge with
// `crypto.subtle.digest` (ADR-0045). Without the digest it sends `plain`.
installCryptoRandom();
installCryptoDigest();

const supabaseUrl = Constants.expoConfig?.extra?.supabaseUrl as string;
const supabaseAnonKey = Constants.expoConfig?.extra?.supabaseAnonKey as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase configuration. " +
      "Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in your environment. " +
      "For EAS builds, set these via `eas env:create` (see CLAUDE.md for details).",
  );
}

// Tag every request so note_content_history.archived_by records which
// platform did a write (see ADR 0023). Platform.OS is "ios" | "android" |
// "web" — the mobile app ships only on iOS and Android, so anything
// unexpected falls back to a generic "mobile" tag rather than silently
// emitting a NULL. Exported for the activity ping (ADR-0080), which sends the
// same tag; usage_daily doesn't accept "mobile", so that fallback never pings.
export const clientTag: DraftoClientTag | "mobile" =
  Platform.OS === "ios" ? "mobile-ios" : Platform.OS === "android" ? "mobile-android" : "mobile";

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: secureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === "web",
    // PKCE, not supabase-js's implicit default (ADR-0045). Redirects into the app
    // (password reset, Apple sign-in on Android) then carry a one-time `code` that
    // only the `code_verifier` in this device's SecureStore can redeem. They never
    // carry session tokens, which any website could forge into a `drafto://` link.
    flowType: "pkce",
    // auth-js keeps one verifier per pending PKCE flow (up to 5), and this flag
    // appends that flow's id to the redirect as `sb_flow_id`. The deep-link
    // handlers pass it back to `exchangeCodeForSession`, so a pending reset or
    // Apple sign-in still completes after a newer flow has started on this
    // device. Supabase matches redirect URLs including the query string, so
    // both hosted projects' Redirect URLs must allow `drafto://reset-password?sb_flow_id=*`
    // and `drafto://auth/callback?sb_flow_id=*`. Without them Supabase drops
    // the redirect for the Site URL (docs/features/auth.md, ADR-0045).
    experimental: { appendPkceFlowIdToRedirects: true },
  },
  global: {
    headers: { "x-drafto-client": clientTag },
  },
});
