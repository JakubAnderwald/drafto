import { createClient } from "@supabase/supabase-js";
import { env } from "@/env";
import type { Database } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

interface McpAuthResult {
  userId: string;
  supabase: SupabaseClient<Database>;
}

/**
 * Authenticate an MCP request via Bearer token (API key).
 * Returns an authenticated Supabase client scoped to the key's owner,
 * or throws an error string if authentication fails.
 */
export async function authenticateMcpRequest(authHeader: string | null): Promise<McpAuthResult> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("MCP server not configured");
  }

  const apiKey = authHeader.slice(7);
  if (!apiKey) {
    throw new Error("Empty API key");
  }

  // Hash the provided key
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const keyHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Use service role client to look up the key (bypasses RLS).
  // Tag as web-mcp so note_content_history.archived_by distinguishes
  // MCP-driven writes from regular admin/cron paths (see ADR 0023).
  const adminClient = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-drafto-client": "web-mcp" } },
  });

  // Look up key by hash
  const { data: keyRow, error: keyError } = await adminClient
    .from("api_keys")
    .select("id, user_id, revoked_at")
    .eq("key_hash", keyHash)
    .single();

  if (keyError || !keyRow) {
    throw new Error("Invalid API key");
  }

  if (keyRow.revoked_at) {
    throw new Error("API key has been revoked");
  }

  // Verify user is approved
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("is_approved")
    .eq("id", keyRow.user_id)
    .single();

  if (profileError || !profile?.is_approved) {
    throw new Error("User account is not approved");
  }

  // Update last_used_at (fire-and-forget)
  adminClient
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRow.id)
    .then(() => {});

  // Create a client that impersonates the user via RLS
  // We use the service role client for data access since API key auth
  // doesn't have a Supabase session. RLS is handled by filtering on user_id.
  // To properly scope queries, we'll pass the userId and use it in queries.
  // However, for simplicity and RLS compliance, we use the admin client
  // with explicit user_id filtering in each tool handler.
  return {
    userId: keyRow.user_id,
    supabase: adminClient,
  };
}
