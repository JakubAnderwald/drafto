"use client";

import { useEffect, useState } from "react";
import { APPLE_REVOCATION_ORIGIN, hasAppleIdentity } from "@drafto/shared";
import { usePageOrigin } from "@/hooks/use-page-origin";
import { loadAppleIdAuth } from "@/lib/apple/apple-js";
import { createClient } from "@/lib/supabase/client";

export interface AppleDeletionConfirmation {
  /** True when the delete flow must ask Apple to confirm first. */
  applies: boolean;
  /** The Apple-linked user the step was decided for, so the flow can check it did not change. */
  userId: string | null;
  /**
   * False while the user lookup that decides `applies` is still running. The
   * dialog must not confirm before then, or an Apple-linked user could delete
   * without the notice and without Apple's confirmation.
   */
  ready: boolean;
}

interface AppleUserLookup {
  settled: boolean;
  appleUserId: string | null;
}

const LOOKUP_PENDING: AppleUserLookup = { settled: false, appleUserId: null };

/**
 * Whether deleting the account should first ask Apple to confirm, so the server
 * can revoke Drafto's Apple tokens: the user has Sign in with Apple linked, and
 * the page is on drafto.eu, the only origin Apple hands the Services ID's codes
 * to. Previews, localhost and other origins skip the step and delete as before.
 *
 * Reads the user when the dialog opens, and then preloads Apple's script so the
 * confirm click can open the popup without waiting.
 */
export function useAppleDeletionConfirmation(open: boolean): AppleDeletionConfirmation {
  const onAppleOrigin = usePageOrigin() === APPLE_REVOCATION_ORIGIN;
  const [lookup, setLookup] = useState<AppleUserLookup>(LOOKUP_PENDING);

  useEffect(() => {
    if (!open || !onAppleOrigin) return;
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(
        ({ data }) => {
          if (cancelled) return;
          const user = data.user;
          setLookup({
            settled: true,
            appleUserId: user && hasAppleIdentity(user) ? user.id : null,
          });
        },
        () => {
          // Without the user there is no Apple step; the deletion still works.
          if (!cancelled) setLookup({ settled: true, appleUserId: null });
        },
      );
    return () => {
      cancelled = true;
      // The next time the dialog opens, it waits for a fresh lookup.
      setLookup(LOOKUP_PENDING);
    };
  }, [open, onAppleOrigin]);

  const ready = !open || !onAppleOrigin || lookup.settled;
  const applies = open && onAppleOrigin && lookup.appleUserId !== null;

  useEffect(() => {
    if (applies) void loadAppleIdAuth();
  }, [applies]);

  return applies
    ? { applies, userId: lookup.appleUserId, ready }
    : { applies: false, userId: null, ready };
}
