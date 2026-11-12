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
 * Longest API key name accepted, measured after trimming in UTF-16 code units
 * (`.length`, the same unit as an input's `maxLength`).
 */
const MAX_API_KEY_NAME_LENGTH = 100;

/**
 * POST /api/api-keys — Generate a new API key.
 * Body: { name?: string } — `name` is trimmed; a missing, empty or
 * whitespace-only name defaults to "Untitled key".
 * Returns: { id, key, key_prefix, name } where `key` is the raw key (shown once).
 * 400 when the body is not a JSON object, when `name` is present but not a
 * string (including `null`), or when the trimmed `name` is longer than
 * MAX_API_KEY_NAME_LENGTH characters. Nothing is generated or stored on a 400.
 */
export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  // `null`, arrays and bare primitives parse fine but aren't a `{ name? }` body.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("Invalid JSON body", 400);
  }

  const rawName = "name" in body ? body.name : undefined;
  if (rawName !== undefined && typeof rawName !== "string") {
    return errorResponse("name must be a string", 400);
  }
  const trimmedName = typeof rawName === "string" ? rawName.trim() : "";
  if (trimmedName.length > MAX_API_KEY_NAME_LENGTH) {
    return errorResponse(`name must be at most ${MAX_API_KEY_NAME_LENGTH} characters`, 400);
  }
  const name = trimmedName || "Untitled key";

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
