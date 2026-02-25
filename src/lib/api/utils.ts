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

  return {
    data: {
      user: { id: user.id, email: user.email ?? "" },
      supabase,
    },
    error: null,
  };
}

export function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message, status }, { status });
}

export function successResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}
