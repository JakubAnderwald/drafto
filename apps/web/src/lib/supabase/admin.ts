import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/env";
import type { Database } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

const cache = new Map<string, SupabaseClient<Database>>();

/**
 * Service-role Supabase client. Bypasses RLS. Callers MUST authorize
 * the request themselves before using this client (e.g. verified admin
 * session, verified webhook signature, verified signed token).
 *
 * `clientTag` is sent as the `x-drafto-client` header on every request.
 * The PostgREST pre_request hook copies it into `app.client` so the
 * note_content_history trigger can record which subsystem performed an
 * overwrite. Pass a more specific tag than the default `web-admin` when
 * the call site is meaningfully distinct (e.g. `web-mcp`, `web-cron`).
 */
export function createAdminClient(clientTag: string = "web-admin"): SupabaseClient<Database> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }
  const cached = cache.get(clientTag);
  if (cached) return cached;
  const client = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: { "x-drafto-client": clientTag },
      },
    },
  );
  cache.set(clientTag, client);
  return client;
}
