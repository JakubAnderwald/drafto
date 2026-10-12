import { createContext, useContext, useEffect, useRef, useCallback, useState } from "react";
import { AppState } from "react-native";
import type { Database } from "@nozbe/watermelondb";
import { Q } from "@nozbe/watermelondb";
import { hasUnsyncedChanges } from "@nozbe/watermelondb/sync";
import NetInfo from "@react-native-community/netinfo";
import { hasLocalEdit } from "@drafto/shared";

import { database } from "@/db";
import { syncDatabase, SyncNetworkError } from "@/db/sync";
import { processPendingUploads, cleanupOrphanedFiles, ensureLocalIdentity } from "@/lib/data";
import { measureAsync } from "@/lib/performance";
import { useAuth } from "@/providers/auth-provider";

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
const PERIODIC_SYNC_MS = 30_000;
/**
 * Quiet period after a local edit before it is pushed, so a burst of writes
 * (typing, a multi-record move) goes out in one sync. See ADR-0048.
 */
export const AUTO_SYNC_DEBOUNCE_MS = 1_500;
/**
 * Extra passes one sync() may chain for writes that landed while it ran.
 * Belt and braces: a pass only chains while such a write is still unpushed.
 */
const MAX_FOLLOW_UP_PASSES = 3;
const SYNCED_TABLES = ["notebooks", "notes", "attachments"] as const;

interface DatabaseContextValue {
  database: Database;
  /**
   * Synchronize, then upload queued attachments. A call made while a sync is
   * running joins it: it returns that run's promise, and the run goes round
   * again if the caller's write is still unpushed. Never rejects; failures
   * land in `lastSyncError`.
   */
  sync: () => Promise<void>;
  hasPendingChanges: boolean;
  pendingChangesCount: number;
  lastSyncedAt: Date | null;
  /** Why the latest sync failed, or null once a sync succeeds. */
  lastSyncError: string | null;
  isSyncing: boolean;
}

interface SyncPassOutcome {
  ok: boolean;
  pending: boolean;
  /** Attachments this pass uploaded after synchronize() had already run. */
  uploaded: number;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

function describeSyncError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function DatabaseProvider({ children }: { children: React.ReactNode }) {
  const { user, isApproved } = useAuth();
  const userId = user?.id ?? null;
  const inFlightSyncRef = useRef<Promise<void> | null>(null);
  // Bumped when the signed-in user (or their approval) changes. A run started
  // for an earlier session neither reports into the new one nor can be joined
  // by it.
  const sessionRef = useRef(0);
  // Set by a sync() call made while a sync runs: its write may have missed the pass.
  const rerunRequestedRef = useRef(false);
  // Set by a local edit committed while a sync runs: it may have missed the pass.
  const editedDuringSyncRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const periodicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncLocalEditsRef = useRef<() => Promise<void>>(async () => {});
  const identityReadyRef = useRef(false);
  const isOnlineRef = useRef(true);
  // Mirrors `user && isApproved` for callbacks that outlive the render that
  // scheduled them (the retry timer). RLS answers an anon or unapproved pull
  // with zero rows and no error, so no sync may run without both. Belt and
  // braces: sync() already bails on identityReadyRef, which the effect below
  // clears in the same commit — this only matters if that coupling changes.
  const canSyncRef = useRef(false);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);
  const [pendingChangesCount, setPendingChangesCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const checkPendingChanges = useCallback(async (): Promise<boolean> => {
    try {
      const pending = await hasUnsyncedChanges({ database });
      setHasPendingChanges(pending);

      if (pending) {
        let count = 0;
        for (const table of SYNCED_TABLES) {
          const dirtyRecords = await database
            .get(table)
            .query(Q.where("_status", Q.notEq("synced")))
            .fetchCount();
          count += dirtyRecords;
        }
        setPendingChangesCount(count);
      } else {
        setPendingChangesCount(0);
      }
      return pending;
    } catch (err) {
      // Unknown, so let the sync decide: it pushes whatever is unsynced and
      // reports its own failure.
      console.warn("[DatabaseProvider] Could not check pending changes:", err);
      return true;
    }
  }, []);

  /** (Re)starts the quiet period after which local edits are pushed. */
  const scheduleLocalEditSync = useCallback(() => {
    if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current);
    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null;
      void syncLocalEditsRef.current();
    }, AUTO_SYNC_DEBOUNCE_MS);
  }, []);

  const sync = useCallback((): Promise<void> => {
    // The cross-account identity guard gates every sync, not just the automatic
    // triggers below: this callback is what the UI drives (the manual sync
    // button, the attachment picker), and screens are interactive while
    // ensureLocalIdentity is still resolving. Syncing before it reports "ready"
    // would push the previous user's rows under this session — the leak the
    // guard exists to prevent.
    if (!identityReadyRef.current) return Promise.resolve();
    if (inFlightSyncRef.current) {
      // Join instead of dropping the call: the caller's write may have missed
      // the running pass, so the run checks for it before settling.
      rerunRequestedRef.current = true;
      return inFlightSyncRef.current;
    }

    const session = sessionRef.current;
    const isCurrentSession = () => sessionRef.current === session;

    const runPass = async (): Promise<SyncPassOutcome> => {
      try {
        const result = await measureAsync("sync", () => syncDatabase(database));
        if (!isCurrentSession()) return { ok: false, pending: false, uploaded: 0 };
        retryCountRef.current = 0;
        setLastSyncedAt(new Date());
        setLastSyncError(null);

        // Upload any locally-queued attachments after sync
        let uploaded = 0;
        try {
          uploaded = await processPendingUploads();
        } catch (uploadErr) {
          console.error("[DatabaseProvider] Attachment upload processing failed:", uploadErr);
        }

        const pending = await checkPendingChanges();

        if (result.remoteChangeCount > 0) {
          const msg =
            result.remoteChangeCount === 1
              ? "A note was updated from another device"
              : `${result.remoteChangeCount} items were updated from another device`;
          console.log(`[Sync] ${msg}`);
        }
        return { ok: true, pending, uploaded };
      } catch (err) {
        if (!isCurrentSession()) return { ok: false, pending: false, uploaded: 0 };
        setLastSyncError(describeSyncError(err));
        if (err instanceof SyncNetworkError) {
          const retryIndex = Math.min(retryCountRef.current, RETRY_DELAYS_MS.length - 1);
          const delay = RETRY_DELAYS_MS[retryIndex];
          retryCountRef.current += 1;

          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            // A retry scheduled before sign-out (or before approval was lost) must
            // not pull afterwards.
            if (!canSyncRef.current) return;
            sync();
          }, delay);
        } else {
          console.error("Sync failed:", err);
        }
        await checkPendingChanges();
        return { ok: false, pending: true, uploaded: 0 };
      }
    };

    const run = (async (): Promise<void> => {
      setIsSyncing(true);
      let followUps = 0;
      try {
        for (;;) {
          rerunRequestedRef.current = false;
          editedDuringSyncRef.current = false;
          const pass = await runPass();
          // A failed pass ends the run: the retry timer (network) or the next
          // trigger tries again, rather than this loop hammering a failure.
          // Not rescheduling here is also what keeps a partly failed push from
          // looping on the notes it re-pulls every pass.
          if (!pass.ok || !identityReadyRef.current || !canSyncRef.current) break;
          const missedWrite = rerunRequestedRef.current || editedDuringSyncRef.current;
          // Uploads run after synchronize(), so the status they record on an
          // uploaded attachment is only pushed (and the pending count only
          // clears) on another pass. A failed upload uploads nothing, so it
          // cannot keep this going.
          const needsAnotherPass = missedWrite || pass.uploaded > 0;
          if (needsAnotherPass && pass.pending && followUps < MAX_FOLLOW_UP_PASSES) {
            followUps += 1;
            continue;
          }
          // A write that landed after the pass's pending check, or beyond the
          // follow-up cap, still goes out once edits pause.
          if (missedWrite) scheduleLocalEditSync();
          break;
        }
      } finally {
        if (isCurrentSession()) {
          inFlightSyncRef.current = null;
          setIsSyncing(false);
        }
      }
    })();
    inFlightSyncRef.current = run;
    return run;
  }, [checkPendingChanges, scheduleLocalEditSync]);

  // Local edits schedule their own sync (ADR-0048): the editor and lists write
  // to the local database and nothing else, and this pushes the write once
  // edits pause.
  const syncLocalEdits = useCallback(async () => {
    if (!canSyncRef.current || !identityReadyRef.current) return;
    const pending = await checkPendingChanges();
    if (pending && isOnlineRef.current && canSyncRef.current && identityReadyRef.current) {
      await sync();
    }
  }, [checkPendingChanges, sync]);

  useEffect(() => {
    syncLocalEditsRef.current = syncLocalEdits;
  }, [syncLocalEdits]);

  useEffect(() => {
    const subscription = database.withChangesForTables([...SYNCED_TABLES]).subscribe((changes) => {
      // `null` is the subscription's initial emission, not a change. A sync's
      // own writes leave records synced, so hasLocalEdit() filters them out;
      // that is what stops this from re-triggering itself.
      if (!changes || !hasLocalEdit(changes)) return;
      if (inFlightSyncRef.current) {
        // The running sync goes round again if this edit is still unpushed.
        editedDuringSyncRef.current = true;
        return;
      }
      scheduleLocalEditSync();
    });
    return () => {
      subscription.unsubscribe();
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current);
        autoSyncTimerRef.current = null;
      }
    };
  }, [scheduleLocalEditSync]);

  useEffect(() => {
    canSyncRef.current = Boolean(userId && isApproved);
  }, [userId, isApproved]);

  // Initial sync when an approved user logs in. The cross-account identity
  // guard runs first (and may reset the local DB) so no sync — the initial one,
  // the periodic / foreground / reconnect / local-edit triggers, or the
  // context-exposed sync() the UI calls — ever pushes or surfaces another user's
  // local data. sync() checks identityReadyRef itself, which is what covers the
  // UI callers that are already interactive while the guard is resolving. If
  // the guard reports "unsafe" it could not clear the previous user's records,
  // so every sync trigger stays parked until a later launch retries the guard
  // successfully. An unapproved user is treated like a signed-out one: RLS
  // would return no rows, and the "empty" pull would advance lastPulledAt past
  // their data. Keyed on the user id, not the user object: a token refresh
  // hands out a new object for the same user, which must not re-run the guard.
  useEffect(() => {
    let cancelled = false;
    if (userId && isApproved) {
      retryCountRef.current = 0;
      identityReadyRef.current = false;
      ensureLocalIdentity(userId).then((status) => {
        if (cancelled) return;
        if (status !== "ready") {
          // The previous user's records are still on disk. Syncing now would push
          // them under this session (RLS rejects them and wedges sync) and surface
          // them in this user's UI, so leave identityReadyRef false and wait for a
          // later launch to retry the guard.
          console.error("[DatabaseProvider] Local data belongs to another user — skipping sync");
          return;
        }
        identityReadyRef.current = true;
        // Sync first, then clean up orphaned files (cleanup needs complete DB state)
        sync().then(() => {
          cleanupOrphanedFiles().catch((cleanupErr) => {
            console.warn("[DatabaseProvider] Orphaned file cleanup failed:", cleanupErr);
          });
        });
      });
    } else {
      identityReadyRef.current = false;
    }
    return () => {
      cancelled = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current);
        autoSyncTimerRef.current = null;
      }
      // End this session's sync state. A sync still running for the previous
      // user settles in the background without being joined by the next one
      // or reporting into its UI (db/sync.ts's resetSyncState does the same
      // for the module-level latch).
      sessionRef.current += 1;
      inFlightSyncRef.current = null;
      rerunRequestedRef.current = false;
      editedDuringSyncRef.current = false;
      setIsSyncing(false);
      setLastSyncError(null);
    };
  }, [userId, isApproved, sync]);

  // Periodic sync for pending changes
  useEffect(() => {
    periodicTimerRef.current = setInterval(async () => {
      if (!userId || !isApproved || !identityReadyRef.current) return;
      const pending = await hasUnsyncedChanges({ database }).catch(() => false);
      if (pending) {
        sync();
      }
    }, PERIODIC_SYNC_MS);

    return () => {
      if (periodicTimerRef.current) {
        clearInterval(periodicTimerRef.current);
        periodicTimerRef.current = null;
      }
    };
  }, [sync, userId, isApproved]);

  // Sync when window comes to foreground
  // On macOS, AppState "active" fires when the app window gains focus
  // (maps to NSApplication.didBecomeActiveNotification)
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && userId && isApproved && identityReadyRef.current) {
        sync();
      }
    });
    return () => subscription.remove();
  }, [sync, userId, isApproved]);

  // Track connectivity for the local-edit trigger, and sync when the network
  // reconnects
  useEffect(() => {
    let wasDisconnected = false;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const isConnected = state.isConnected ?? false;
      isOnlineRef.current = isConnected;
      if (!isConnected) {
        wasDisconnected = true;
      } else if (wasDisconnected && userId && isApproved && identityReadyRef.current) {
        wasDisconnected = false;
        retryCountRef.current = 0;
        sync();
      }
    });
    return () => unsubscribe();
  }, [sync, userId, isApproved]);

  return (
    <DatabaseContext.Provider
      value={{
        database,
        sync,
        hasPendingChanges,
        pendingChangesCount,
        lastSyncedAt,
        lastSyncError,
        isSyncing,
      }}
    >
      {children}
    </DatabaseContext.Provider>
  );
}

export function useDatabase(): DatabaseContextValue {
  const context = useContext(DatabaseContext);
  if (!context) {
    throw new Error("useDatabase must be used within a DatabaseProvider");
  }
  return context;
}
