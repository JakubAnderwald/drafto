import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { isSignedOutAuthError } from "@/lib/supabase/auth-errors";
import { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export interface AdminSession {
  /** The admin's own session client (RLS applies). */
  supabase: ServerSupabaseClient;
  user: User;
}

/**
 * The admin pages' guard. A missing or rejected session goes to `/login`, a
 * signed-in non-admin to `/`. Any other error, Auth API server errors included,
 * is rethrown so it reaches Sentry.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError && !isSignedOutAuthError(userError)) throw userError;
  if (!user) redirect("/login");

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (profileError) throw profileError;
  if (!profile?.is_admin) redirect("/");

  return { supabase, user };
}
