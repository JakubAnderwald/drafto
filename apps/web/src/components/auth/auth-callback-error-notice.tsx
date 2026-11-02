"use client";

import { useSearchParams } from "next/navigation";

const AUTH_CALLBACK_ERROR_MESSAGE =
  "That link couldn't sign you in. It may have expired, or been opened in a different browser from the one that asked for it. Log in below instead.";

interface AuthCallbackErrorNoticeProps {
  /** Hides the notice once the user has tried to log in, so only the form's own error shows. */
  hidden?: boolean;
}

/**
 * Explains a failed link on the login page. `/auth/callback` redirects to
 * `/login?error=auth-callback-error` when it cannot exchange the code: an expired or reused
 * link, or a confirmation or OAuth link opened in another browser, which lacks the PKCE
 * verifier. Fixed copy only — the query string is not trusted. Callers must render it inside
 * a `<Suspense>` boundary (it reads search params).
 */
export function AuthCallbackErrorNotice({ hidden = false }: AuthCallbackErrorNoticeProps) {
  const searchParams = useSearchParams();

  if (hidden || searchParams.get("error") !== "auth-callback-error") return null;

  return (
    <div
      role="alert"
      data-testid="auth-callback-error-notice"
      className="text-error bg-error-bg mb-4 rounded-md p-3 text-sm"
    >
      {AUTH_CALLBACK_ERROR_MESSAGE}
    </div>
  );
}
