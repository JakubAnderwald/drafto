import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";

/**
 * GET /api/api-keys — List the current user's API keys (excludes key_hash).
 */
export async function GET(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  const { data, error } = await supabase
    .from("api_keys")
    .select("id, key_prefix, name, created_at, last_used_at, revoked_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return errorResponse(error.message, 500);

  return successResponse(data);
}

/**
 * POST /api/api-keys — Generate a new API key.
 * Body: { name?: string }
 * Returns: { id, key, key_prefix, name } where `key` is the raw key (shown once).
 */
export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  const body = (await request.json()) as { name?: string };
  const name = (body.name ?? "").trim() || "Untitled key";

  // Generate a random API key: "dk_" prefix + 48 random hex chars
  const randomBytes = new Uint8Array(24);
  crypto.getRandomValues(randomBytes);
  const randomHex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rawKey = `dk_${randomHex}`;
  const keyPrefix = rawKey.slice(0, 8);

  // Hash the key
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(rawKey));
  const keyHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const { data, error } = await supabase
    .from("api_keys")
    .insert({ user_id: user.id, key_prefix: keyPrefix, key_hash: keyHash, name })
    .select("id, key_prefix, name")
    .single();

  if (error) return errorResponse(error.message, 500);

  // Return the raw key — it can only be seen this once
  return NextResponse.json({ ...data, key: rawKey }, { status: 201 });
}
