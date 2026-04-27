import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import { Platform } from "react-native";

import type { Database } from "@drafto/shared";

import { secureStoreAdapter } from "./secure-store-adapter";

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
  },
  global: {
    headers: { "x-drafto-client": clientTag },
  },
});
