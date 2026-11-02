"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { IconButton } from "@/components/ui/icon-button";
import { shouldCloseOnEscape } from "@/app/(app)/admin/should-close-on-escape";

// The root element of the admin page (see page.tsx).
const ADMIN_PANEL_SELECTOR = '[data-testid="admin-panel"]';

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
 * Closes the Admin — User Approval panel, on click or on Escape, by
 * soft-navigating to "/". The (app) layout stays mounted, so the selected
 * notebook and note are kept and the page doesn't reload. `push("/")` rather
 * than `back()`: after a direct load or refresh there is no history to go
 * back to, and `back()` could leave the app.
 */
export function AdminCloseButton() {
  const router = useRouter();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const panel = buttonRef.current?.closest<HTMLElement>(ADMIN_PANEL_SELECTOR) ?? null;
      if (shouldCloseOnEscape(event, panel)) {
        router.push("/");
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  return (
    <IconButton ref={buttonRef} size="sm" aria-label="Close admin" onClick={() => router.push("/")}>
      <CloseIcon />
    </IconButton>
  );
}
