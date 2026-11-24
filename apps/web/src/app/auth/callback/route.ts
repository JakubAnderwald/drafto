import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { sanitizeRedirectPath } from "@/lib/auth/redirect-path";
import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/report-error";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = sanitizeRedirectPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    try {
      const { error } = await supabase.auth.exchangeCodeForSession(code);

      if (!error) {
        return NextResponse.redirect(new URL(next, request.url));
      }

      // A returned AuthError is usually an expired or reused link: routine, so a warning.
      reportError(error, "auth:callback", { level: "warning" });
    } catch (err) {
      reportError(err, "auth:callback");
    }
  }

  return NextResponse.redirect(new URL("/login?error=auth-callback-error", request.url));
}
