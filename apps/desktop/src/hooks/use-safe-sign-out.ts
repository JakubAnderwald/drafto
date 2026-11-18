import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import { SIGN_OUT_CONFIRM_TITLE, describeSignOut, withTimeout } from "@drafto/shared";

import { countUnsyncedChanges } from "@/lib/data/unsynced-changes";
import { flushPendingSaves } from "@/lib/pending-saves";
import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";

/** How long sign-out waits for a last sync before it counts what would be lost. */
export const PRE_SIGN_OUT_SYNC_TIMEOUT_MS = 10_000;

/** Resolves true only when the user picks the destructive confirm button. */
function confirmSignOut(pending: number | null): Promise<boolean> {
  const { message, confirmLabel } = describeSignOut(pending);
  return new Promise((resolve) => {
    Alert.alert(
      SIGN_OUT_CONFIRM_TITLE,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
      ],
      // Android: tapping outside the dialog or the back key counts as Cancel.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Whether the sign-out may skip the provider's last flush. Only when nothing is pending beyond
 * what the confirmation told the user: the dialog can stay open for any length of time, so the
 * count is taken again once the user has confirmed. A change made meanwhile, or a count that can
 * no longer be read, gets the provider's (bounded) flush instead of being wiped silently. A count
 * that failed before the dialog counts as 0 shown, so a recount of 0 still skips the flush.
 */
function canSkipFinalSync(shown: number | null, now: number | null): boolean {
  return now !== null && now <= (shown ?? 0);
}

export interface SafeSignOut {
  signOut: () => Promise<void>;
  isSigningOut: boolean;
}

/**
 * Sign-out that always asks first and does not drop unsynced changes silently. Sign-out wipes
 * the local database, so it first writes any debounced editor save, and when changes are
 * pending it lets one more sync run and counts again. Then it shows exactly one confirmation:
 * how many changes are still unsynced (offline, or the sync failed), that everything is
 * synced, or, when the count failed, that unsynced changes would be lost.
 *
 * `isSigningOut` is true while the last sync runs and once the user has confirmed, never while
 * the confirmation is open. A confirmation never blocks a later sign-out either: if the native
 * alert goes away without calling back (an Android activity recreation, a closed macOS window),
 * the next press asks again, and an answer to the abandoned dialog is ignored.
 *
 * It relies on the database provider's `sync()` joining a sync that is already running and
 * never rejecting (ADR-0048), so awaiting it also covers a sync in flight.
 */
export function useSafeSignOut(): SafeSignOut {
  const { signOut } = useAuth();
  const { database, sync } = useDatabase();
  const [isSigningOut, setIsSigningOut] = useState(false);
  // Refs, so a double tap inside one frame cannot start two sign-outs. `busyRef` covers the
  // preparation and the sign-out itself but not the confirmation; `attemptRef` lets a newer
  // attempt supersede one whose confirmation never answered.
  const busyRef = useRef(false);
  const attemptRef = useRef(0);

  const safeSignOut = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const attempt = ++attemptRef.current;
    const isCurrent = () => attemptRef.current === attempt;

    // null when the count cannot be read.
    const countPending = async (): Promise<number | null> => {
      try {
        return await countUnsyncedChanges(database);
      } catch (error) {
        console.error("Couldn't count unsynced changes before sign-out:", error);
        return null;
      }
    };

    try {
      // An edit still inside an editor's save debounce is not in the database yet, so it would
      // be neither counted nor synced. Write it first.
      await flushPendingSaves();
      let pending = await countPending();
      if (pending !== null && pending > 0) {
        setIsSigningOut(true);
        // Bounded: a hung request must not hang sign-out.
        await withTimeout<unknown>(sync(), PRE_SIGN_OUT_SYNC_TIMEOUT_MS, null);
        pending = await countPending();
        setIsSigningOut(false);
      }

      busyRef.current = false;
      const confirmed = await confirmSignOut(pending);
      // A newer attempt superseded this one: its own confirmation is the one that counts.
      if (!isCurrent() || !confirmed) return;
      busyRef.current = true;
      setIsSigningOut(true);

      await flushPendingSaves();
      const stillPending = await countPending();
      if (canSkipFinalSync(pending, stillPending)) {
        // Nothing to push, or only the changes the user chose to drop after the last sync could
        // not push them: the provider's flush would only repeat that attempt.
        await signOut({ skipFinalSync: true });
      } else {
        // The count failed, or something changed while the dialog was open: confirming must not
        // trap the user in the account, so sign out with the provider's own last flush.
        await signOut();
      }
    } catch (error) {
      console.error("Sign-out failed:", error);
      Alert.alert("Couldn't sign out", "Check your connection and try again.");
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setIsSigningOut(false);
      }
    }
  }, [database, sync, signOut]);

  return { signOut: safeSignOut, isSigningOut };
}
