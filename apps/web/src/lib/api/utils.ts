import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

interface AuthenticatedUser {
  user: { id: string; email: string };
  supabase: SupabaseClient<Database>;
}

type AuthResult = { data: AuthenticatedUser; error: null } | { data: null; error: NextResponse };

export async function getAuthenticatedUser(): Promise<AuthResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      data: null,
      error: NextResponse.json({ error: "Unauthorized", status: 401 }, { status: 401 }),
    };
  }

  // Check approval status — unapproved users must not access API routes
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_approved")
    .eq("id", user.id)
    .single();

  if (profileError || !profile?.is_approved) {
    return {
      data: null,
      error: NextResponse.json({ error: "Forbidden", status: 403 }, { status: 403 }),
    };
  }

  return {
    data: {
      user: { id: user.id, email: user.email ?? "" },
      supabase,
    },
    error: null,
  };
}

/**
 * Fast-path authentication that reads verified auth state from middleware headers.
 * Middleware already validated the session and approval status, so this skips
 * the redundant getUser() + profiles query (~200ms savings per request).
 * Falls back to full auth if headers are absent (e.g., direct API calls).
 */
export async function getAuthenticatedUserFast(request: NextRequest): Promise<AuthResult> {
  const userId = request.headers.get("x-verified-user-id");
  const userEmail = request.headers.get("x-verified-user-email");

  if (!userId) {
    return getAuthenticatedUser();
  }

  const supabase = await createClient();

  return {
    data: {
      user: { id: userId, email: userEmail ?? "" },
      supabase,
    },
    error: null,
  };
}

/**
 * Authenticate the user and verify they own the given note.
 * Combines authentication + note ownership check (used by all attachment routes).
 * When request is provided, uses the fast-path auth from middleware headers.
 */
export async function getAuthenticatedNoteOwner(
  noteId: string,
  request?: NextRequest,
): Promise<{ data: AuthenticatedUser; error: null } | { data: null; error: NextResponse }> {
  const { data: auth, error: authError } = request
    ? await getAuthenticatedUserFast(request)
    : await getAuthenticatedUser();
  if (authError) return { data: null, error: authError };

  const { supabase, user } = auth;

  const { data: note, error: noteError } = await supabase
    .from("notes")
    .select("id")
    .eq("id", noteId)
    .eq("user_id", user.id)
    .single();

  if (noteError || !note) {
    return {
      data: null,
      error: NextResponse.json({ error: "Note not found", status: 404 }, { status: 404 }),
    };
  }

  return { data: auth, error: null };
}

export function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message, status }, { status });
}

export function successResponse<T>(
  data: T,
  status = 200,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json(data, { status, headers });
}
