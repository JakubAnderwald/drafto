import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import { withTimeout } from "@drafto/shared";

import { countUnsyncedChanges } from "@/lib/data/unsynced-changes";
import { flushPendingSaves } from "@/lib/pending-saves";
import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";

/** How long sign-out waits for a last sync before it counts what would be lost. */
export const PRE_SIGN_OUT_SYNC_TIMEOUT_MS = 10_000;

export function describeUnsyncedLoss(count: number): string {
  return count === 1
    ? "1 change hasn't synced and will be lost."
    : `${count} changes haven't synced and will be lost.`;
}

/** Resolves true only when the user picks "Sign out anyway". */
function confirmSignOutAnyway(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Sign out?",
      describeUnsyncedLoss(count),
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Sign out anyway", style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export interface SafeSignOut {
  signOut: () => Promise<void>;
  isSigningOut: boolean;
}

/**
 * Sign-out that does not drop unsynced changes silently. Sign-out wipes the local database,
 * so it first writes any debounced editor save, and when changes are pending it lets one more
 * sync run, counts again, and asks before discarding whatever is still unsynced (offline, or
 * the sync failed).
 *
 * It relies on the database provider's `sync()` joining a sync that is already running and
 * never rejecting (ADR-0048), so awaiting it also covers a sync in flight.
 */
export function useSafeSignOut(): SafeSignOut {
  const { signOut } = useAuth();
  const { database, sync } = useDatabase();
  const [isSigningOut, setIsSigningOut] = useState(false);
  // A ref, so a double tap inside one frame cannot start two sign-outs.
  const inFlightRef = useRef(false);

  const safeSignOut = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsSigningOut(true);

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
        // Bounded: a hung request must not hang sign-out.
        await withTimeout<unknown>(sync(), PRE_SIGN_OUT_SYNC_TIMEOUT_MS, null);
        pending = await countPending();
      }

      if (pending === null) {
        // A failed count must not trap the user in the account: sign out as before, unwarned,
        // with the provider's own last flush.
        await signOut();
        return;
      }
      if (pending > 0 && !(await confirmSignOutAnyway(pending))) return;
      // Everything was synced just now, or the user chose to drop what could not be: the
      // provider's flush would only repeat that attempt.
      await signOut({ skipFinalSync: true });
    } catch (error) {
      console.error("Sign-out failed:", error);
      Alert.alert("Couldn't sign out", "Check your connection and try again.");
    } finally {
      inFlightRef.current = false;
      setIsSigningOut(false);
    }
  }, [database, sync, signOut]);

  return { signOut: safeSignOut, isSigningOut };
}
