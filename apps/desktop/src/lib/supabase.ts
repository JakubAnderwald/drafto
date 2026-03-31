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
  },
});
