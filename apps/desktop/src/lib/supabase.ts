import { createClient } from "@supabase/supabase-js";

import type { Database } from "@drafto/shared";

import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabaseUrl, supabaseAnonKey } from "./config";

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase configuration. " +
      "Set SUPABASE_URL and SUPABASE_ANON_KEY in src/lib/config.ts.",
  );
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    // AsyncStorage for session persistence until keychain entitlements are configured.
    // TODO: Switch back to keychainAdapter once App Sandbox keychain access is resolved.
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: "pkce",
  },
  // Tag every request so note_content_history.archived_by records which
  // platform did a write (see ADR 0023). The desktop app today targets
  // macOS only — if a future build lands on Windows/Linux, broaden this
  // mapping rather than emitting a NULL.
  global: {
    headers: { "x-drafto-client": "desktop-macos" },
  },
});
