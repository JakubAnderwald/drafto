import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import { Platform } from "react-native";

import type { Database } from "@drafto/shared";

import { installCryptoRandom } from "@/lib/crypto-random";
import { secureStoreAdapter } from "./secure-store-adapter";

// Before any auth call: supabase-js draws the PKCE `code_verifier` from it.
installCryptoRandom();

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
// emitting a NULL.
const clientTag =
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
  },
  global: {
    headers: { "x-drafto-client": clientTag },
  },
});
