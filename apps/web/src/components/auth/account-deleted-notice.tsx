"use client";

import { useSearchParams } from "next/navigation";

/**
 * Confirms a completed account deletion on the login page. The settings page
 * redirects to `/login?deleted=1` once the server has deleted the account.
 * Callers must render it inside a `<Suspense>` boundary (it reads search params).
 */
export function AccountDeletedNotice() {
  const searchParams = useSearchParams();

  if (searchParams.get("deleted") !== "1") return null;

  return (
    <div
      role="status"
      data-testid="account-deleted-notice"
      className="bg-success-bg text-success-text mb-4 rounded-md p-3 text-sm"
    >
      Your account has been deleted.
    </div>
  );
}
