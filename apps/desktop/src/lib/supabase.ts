import { createClient } from "@supabase/supabase-js";

import type { Database } from "@drafto/shared";

import AsyncStorage from "@react-native-async-storage/async-storage";
import { installCryptoRandom } from "@/lib/crypto-random";
import { supabaseUrl, supabaseAnonKey } from "./config";

/**
 * Settles once the PKCE crypto is in place (ADR-0062). supabase-js draws the
 * `code_verifier` from `crypto.getRandomValues`, installed at once, and hashes
 * it into an S256 challenge with `crypto.subtle`, which lands only after the
 * native SHA-256 self-test. Await this before any call that starts a PKCE flow
 * (`signInWithOAuth`, `signUp`, `resetPasswordForEmail`): one started while it
 * is pending sends a `plain` challenge. It never rejects, and settles within
 * the self-test's time limit.
 */
export const cryptoReady: Promise<void> = installCryptoRandom();

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase configuration. " +
      "Set SUPABASE_URL and SUPABASE_ANON_KEY in apps/desktop/.env (debug builds) " +
      "or .env.production (release builds).",
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
