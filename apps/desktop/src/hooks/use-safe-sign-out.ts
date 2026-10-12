import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { countUnsyncedChanges } from "@/lib/data/unsynced-changes";
import { withTimeout } from "@/lib/with-timeout";
import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";

/** How long sign-out waits for syncing before it counts what would be lost. */
export const PRE_SIGN_OUT_SYNC_TIMEOUT_MS = 10_000;
/** How often it looks whether a sync that was already running has finished. */
const SYNC_POLL_MS = 250;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SafeSignOut {
  signOut: () => Promise<void>;
  isSigningOut: boolean;
}

/**
 * Sign-out that does not drop unsynced changes silently. Sign-out wipes the local database,
 * so when changes are pending it first lets syncing finish (a sync already running, then one
 * more), counts again, and asks before discarding whatever is still unsynced (offline, or the
 * sync failed).
 */
export function useSafeSignOut(): SafeSignOut {
  const { signOut } = useAuth();
  const { database, sync, isSyncing } = useDatabase();
  const [isSigningOut, setIsSigningOut] = useState(false);
  // A ref, so a double tap inside one frame cannot start two sign-outs.
  const inFlightRef = useRef(false);
  // The latest isSyncing, for the flow below to read after its awaits.
  const isSyncingRef = useRef(isSyncing);
  useEffect(() => {
    isSyncingRef.current = isSyncing;
  }, [isSyncing]);

  /** Lets syncing finish, giving up at `deadline`: a hung request must not hang sign-out. */
  const settleSync = useCallback(
    async (deadline: number) => {
      // A sync that is already running may make sync() return at once rather than wait for
      // it, and its push may be exactly what is pending. Wait it out first.
      while (isSyncingRef.current && Date.now() < deadline) {
        await delay(SYNC_POLL_MS);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      try {
        await withTimeout(sync(), remaining);
      } catch (error) {
        console.warn("Sync before sign-out failed or timed out:", error);
      }
    },
    [sync],
  );

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
      let pending = await countPending();
      if (pending !== null && pending > 0) {
        await settleSync(Date.now() + PRE_SIGN_OUT_SYNC_TIMEOUT_MS);
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
  }, [database, settleSync, signOut]);

  return { signOut: safeSignOut, isSigningOut };
}
