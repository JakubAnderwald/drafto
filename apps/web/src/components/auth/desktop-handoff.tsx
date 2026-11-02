"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClassName } from "@/components/ui/button-styles";
import {
  buildDesktopDeepLink,
  type DesktopDeepLink,
  type DesktopFlow,
} from "@/lib/auth/desktop-deep-link";
import { isMacDesktop } from "@/lib/auth/is-mac-desktop";

interface HandoffCopy {
  successTitle: string;
  successBody: string;
  /** Shown instead of the success copy on a device that cannot run the Mac app. */
  notMacTitle: string;
  notMacBody: string;
  errorTitle: string;
  errorMessage: string;
  errorHint: string;
  emptyTitle: string;
  emptyBody: string;
}

// Fixed copy only: Supabase's error text is never rendered, because the URL is
// attacker-controlled and would let anyone put words on drafto.eu.
const COPY: Record<DesktopFlow, HandoffCopy> = {
  callback: {
    // The app has not exchanged the code yet, so this must not claim success.
    successTitle: "Finishing sign-in in Drafto",
    successBody: "Return to Drafto to finish signing in. You can close this tab.",
    notMacTitle: "Finishing sign-in in Drafto",
    notMacBody:
      "Signing in finishes in the Drafto Mac app. Return to the Mac where you started signing in.",
    errorTitle: "Couldn't sign in",
    errorMessage: "Sign-in was cancelled or didn't finish.",
    errorHint: "Go back to Drafto and try again.",
    emptyTitle: "Nothing to sign in with",
    emptyBody:
      "This page finishes signing in to the Drafto Mac app. Start signing in from the app.",
  },
  recovery: {
    successTitle: "Opening Drafto to reset your password",
    successBody:
      "Set your new password in the Drafto app. This link only works on the Mac where you asked for the reset. You can close this tab.",
    notMacTitle: "Open this link on your Mac",
    notMacBody:
      "This password reset link only works on the Mac where you asked for the reset. Open the email on that Mac and click the link there.",
    errorTitle: "Couldn't reset your password",
    errorMessage: "This reset link has expired or was already used.",
    errorHint: "Request a new link from the Drafto app on your Mac.",
    emptyTitle: "This reset link is incomplete",
    emptyBody:
      "Open the link from your password reset email on the Mac where you asked for the reset.",
  },
};

interface Handoff {
  link: DesktopDeepLink;
  onMac: boolean;
}

/**
 * Hands the result of a Supabase redirect to the macOS app.
 *
 * Runs only in the browser: the code and any error can sit in the fragment,
 * which never reaches the server. Deliberately creates no Supabase client — the
 * PKCE verifier lives in the app, and a browser client would try (and fail) to
 * exchange the code itself.
 */
export function DesktopHandoff({ flow }: { flow: DesktopFlow }) {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  // Strict Mode runs effects twice; the second run would read the already-cleared
  // URL and overwrite the link, so the hand-off happens exactly once.
  const handedOff = useRef(false);

  useEffect(() => {
    if (handedOff.current) return;
    handedOff.current = true;

    const link = buildDesktopDeepLink(flow, window.location.search, window.location.hash);
    const onMac = isMacDesktop(navigator.userAgent, navigator.maxTouchPoints);
    // Keep the one-time code out of the address bar and the history.
    window.history.replaceState(window.history.state, "", window.location.pathname);
    // The link only exists in the browser, so it can only be read after mount.
    setHandoff({ link, onMac });

    // Open the app on its own only where it can be installed; elsewhere the
    // custom scheme would just fail.
    if (link.code && onMac) {
      window.location.href = link.url;
    }
  }, [flow]);

  const copy = COPY[flow];

  if (!handoff) {
    return (
      <div data-testid="desktop-handoff" data-state="pending" className="text-center">
        <h1 className="text-fg text-xl font-semibold">Opening Drafto…</h1>
      </div>
    );
  }

  const { link, onMac } = handoff;
  const state = link.code ? (onMac ? "success" : "not-mac") : link.hasError ? "error" : "empty";

  const openButton = (
    <a
      href={link.url}
      data-testid="open-drafto-link"
      className={buttonClassName({ className: "mt-6" })}
    >
      Open Drafto
    </a>
  );

  return (
    <div data-testid="desktop-handoff" data-state={state} className="text-center">
      {state === "success" && (
        <>
          <h1 className="text-fg text-xl font-semibold">{copy.successTitle}</h1>
          <p className="text-fg-muted mt-3 text-sm">{copy.successBody}</p>
          {openButton}
          <p className="text-fg-subtle mt-3 text-xs">
            Drafto didn&apos;t open? Use the button above.
          </p>
        </>
      )}
      {state === "not-mac" && (
        <>
          <h1 className="text-fg text-xl font-semibold">{copy.notMacTitle}</h1>
          <p className="text-fg-muted mt-3 text-sm">{copy.notMacBody}</p>
          {openButton}
        </>
      )}
      {state === "error" && (
        <>
          <h1 className="text-fg text-xl font-semibold">{copy.errorTitle}</h1>
          <p className="text-error mt-3 text-sm" role="alert">
            {copy.errorMessage}
          </p>
          <p className="text-fg-muted mt-2 text-sm">{copy.errorHint}</p>
          {openButton}
        </>
      )}
      {state === "empty" && (
        <>
          <h1 className="text-fg text-xl font-semibold">{copy.emptyTitle}</h1>
          <p className="text-fg-muted mt-3 text-sm">{copy.emptyBody}</p>
        </>
      )}
    </div>
  );
}
