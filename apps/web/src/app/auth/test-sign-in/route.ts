// Preview-only sign-in for the factory browser runner (ADR-0051).
//
// The runner drives Chrome against a PR's Vercel preview, which uses the dev Supabase project.
// Claude in Chrome won't type a password on a non-local host, so the runner signs in by opening
// a one-time link instead: `/auth/test-sign-in?token_hash=<hashed_token>&next=/`. Bash on the
// Mac mini mints `hashed_token` with Supabase's admin `generate_link` (type `magiclink`), which
// needs the dev service-role key. Nobody without that key can mint a token this route accepts.
//
// It answers 404 everywhere except a preview deployment backed by the dev project, so it can
// never sign anyone in on drafto.eu. See `isTestSignInEnabled` for the two checks.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { env } from "@/env";
import { sanitizeRedirectPath } from "@/lib/auth/redirect-path";
import { isTestSignInEnabled } from "@/lib/auth/test-sign-in";
import { createClient } from "@/lib/supabase/server";

const FAILURE_PATH = "/login?error=test-sign-in-failed";

export async function GET(request: NextRequest) {
  if (
    !isTestSignInEnabled({
      vercelEnv: env.VERCEL_ENV,
      supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    })
  ) {
    return new NextResponse(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const next = sanitizeRedirectPath(searchParams.get("next"));

  // The token is a credential until it is used: none of the logging below includes it.
  if (tokenHash) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: "magiclink",
      });

      if (!error) {
        return NextResponse.redirect(new URL(next, request.url));
      }

      console.error("[auth/test-sign-in] verifyOtp failed:", error.message);
    } catch (err) {
      console.error(
        "[auth/test-sign-in] verifyOtp threw unexpectedly:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.redirect(new URL(FAILURE_PATH, request.url));
}
