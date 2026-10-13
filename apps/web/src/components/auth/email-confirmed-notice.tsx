"use client";

import { useSearchParams } from "next/navigation";
import { EMAIL_CONFIRMED } from "@drafto/shared";

/**
 * Confirms the email address on the login page. The sign-up confirmation email of the mobile
 * and desktop apps lands on `/login?confirmed=1` (`SIGNUP_EMAIL_REDIRECT_URL`); Supabase has
 * confirmed the address by then. The `code` it appends belongs to the app's PKCE flow and is
 * ignored here. Callers must render it inside a `<Suspense>` boundary (it reads search params).
 */
export function EmailConfirmedNotice() {
  const searchParams = useSearchParams();

  if (searchParams.get("confirmed") !== "1") return null;

  return (
    <div
      role="status"
      data-testid="email-confirmed-notice"
      className="bg-success-bg text-success-text mb-4 rounded-md p-3 text-sm"
    >
      {EMAIL_CONFIRMED}
    </div>
  );
}
