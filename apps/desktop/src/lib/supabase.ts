import { createClient } from "@supabase/supabase-js";

import type { Database } from "@drafto/shared";

import { keychainAdapter } from "./keychain-adapter";
import { supabaseUrl, supabaseAnonKey } from "./config";

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase configuration. " +
      "Set SUPABASE_URL and SUPABASE_ANON_KEY in src/lib/config.ts.",
  );
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: keychainAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
