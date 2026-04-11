import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

interface AuthenticatedUser {
  user: { id: string; email: string };
  supabase: SupabaseClient<Database>;
}

export async function getAuthenticatedUser(): Promise<
  { data: AuthenticatedUser; error: null } | { data: null; error: NextResponse }
> {
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
 * Authenticate the user and verify they own the given note.
 * Combines getAuthenticatedUser + note ownership check (used by all attachment routes).
 */
export async function getAuthenticatedNoteOwner(
  noteId: string,
): Promise<{ data: AuthenticatedUser; error: null } | { data: null; error: NextResponse }> {
  const { data: auth, error: authError } = await getAuthenticatedUser();
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

export function successResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}
