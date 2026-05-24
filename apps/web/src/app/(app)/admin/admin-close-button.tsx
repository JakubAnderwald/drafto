"use client";

import { useRouter } from "next/navigation";
import { IconButton } from "@/components/ui/icon-button";

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

/**
 * Small close button for the admin user-approval page. Navigates back to the
 * app home via client-side routing (`router.push`), so the panel closes
 * immediately without a full page reload. `push("/")` is used rather than
 * `router.back()` because the history stack can be empty on direct loads.
 */
export function AdminCloseButton() {
  const router = useRouter();

  return (
    <IconButton size="sm" aria-label="Close admin" onClick={() => router.push("/")}>
      <CloseIcon />
    </IconButton>
  );
}
