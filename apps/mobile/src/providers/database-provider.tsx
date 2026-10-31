import { createContext, useContext, useEffect, useRef, useCallback, useState } from "react";
import { AppState } from "react-native";
import type { Database } from "@nozbe/watermelondb";
import { Q } from "@nozbe/watermelondb";
import { hasUnsyncedChanges } from "@nozbe/watermelondb/sync";
import NetInfo from "@react-native-community/netinfo";
import { hasLocalEdit } from "@drafto/shared";

import { database } from "@/db";
import { syncDatabase, SyncNetworkError } from "@/db/sync";
import { processPendingUploads } from "@/lib/data/attachment-queue";
import type { UploadResult } from "@/lib/data/attachment-queue";
import { ensureLocalIdentity } from "@/lib/data/local-identity";
import { measureAsync } from "@/lib/performance";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/components/toast";

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
const PERIODIC_SYNC_MS = 30_000;
/**
 * Quiet period after a local edit before it is pushed, so a burst of writes
 * (typing, a multi-record move) goes out in one sync. See ADR-0048.
 */
export const AUTO_SYNC_DEBOUNCE_MS = 1_500;
/**
 * Quiet period after a local edit before the pending count is refreshed, so
 * the sync status shows an unpushed edit before its sync starts. Debounced so
 * that typing (whose autosave writes are already 500 ms apart) runs one count
 * per write, not one per keystroke.
 */
export const PENDING_REFRESH_DEBOUNCE_MS = 500;
/**
 * Extra passes one sync() may chain for writes that landed while it ran.
 * Belt and braces: a pass only chains while such a write is still unpushed.
 */
const MAX_FOLLOW_UP_PASSES = 3;
const SYNCED_TABLES = ["notebooks", "notes", "attachments"] as const;

interface DatabaseContextValue {
  database: Database;
  /**
   * Upload queued attachments and synchronize. A call made while a sync is
   * running joins it: it returns that run's promise, and the run goes round
   * again if the caller's write is still unpushed. Never rejects; failures
   * land in `lastSyncError`.
   */
  sync: () => Promise<UploadResult>;
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
  uploadResult: UploadResult;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

function describeSyncError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function DatabaseProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { showToast } = useToast();
  const inFlightSyncRef = useRef<Promise<UploadResult> | null>(null);
  // Bumped when the signed-in user changes. A run started for an earlier
  // session neither reports into the new one nor can be joined by it.
  const sessionRef = useRef(0);
  // Set by a sync() call made while a sync runs: its write may have missed the pass.
  const rerunRequestedRef = useRef(false);
  // Set by a local edit committed while a sync runs: it may have missed the pass.
  const editedDuringSyncRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const periodicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every pending check and by a session change. Only the most
  // recently started check of the current session reports: an older one (a
  // refresh that read the rows just before a push marked them synced) must not
  // overwrite a newer reading.
  const pendingCheckRef = useRef(0);
  const syncLocalEditsRef = useRef<() => Promise<void>>(async () => {});
  const identityReadyRef = useRef(false);
  const isOnlineRef = useRef(true);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);
  const [pendingChangesCount, setPendingChangesCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const checkPendingChanges = useCallback(async (): Promise<boolean> => {
    pendingCheckRef.current += 1;
    const check = pendingCheckRef.current;
    try {
      const pending = await hasUnsyncedChanges({ database });
      let count = 0;
      if (pending) {
        for (const table of SYNCED_TABLES) {
          const dirtyRecords = await database
            .get(table)
            .query(Q.where("_status", Q.notEq("synced")))
            .fetchCount();
          // Queries leave out deleted records, so a local deletion (which
          // hasUnsyncedChanges does see) is counted separately.
          const deletedRecords = await database.adapter.getDeletedRecords(table);
          count += dirtyRecords + deletedRecords.length;
        }
      }
      // WatermelonDB runs reads in order, so a check started later saw a later
      // state. The caller still gets its own reading.
      if (pendingCheckRef.current === check) {
        setHasPendingChanges(pending);
        setPendingChangesCount(count);
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

  /** (Re)starts the quiet period after which the pending count is refreshed. */
  const schedulePendingRefresh = useCallback(() => {
    if (pendingRefreshTimerRef.current) clearTimeout(pendingRefreshTimerRef.current);
    pendingRefreshTimerRef.current = setTimeout(() => {
      pendingRefreshTimerRef.current = null;
      // Until the identity guard clears, the local rows may still be the
      // previous user's, so there is nothing of this user's to count.
      if (!identityReadyRef.current) return;
      void checkPendingChanges();
    }, PENDING_REFRESH_DEBOUNCE_MS);
  }, [checkPendingChanges]);

  const sync = useCallback((): Promise<UploadResult> => {
    // The cross-account identity guard gates every sync, not just the automatic
    // triggers below: this callback is what the UI drives (autosave, pull to
    // refresh, the manual sync button), and RouteGuard renders inside this
    // provider, so screens are interactive while ensureLocalIdentity is still
    // resolving. Syncing before it reports "ready" would push the previous
    // user's rows under this session — the leak the guard exists to prevent.
    if (!identityReadyRef.current) return Promise.resolve({ uploaded: 0, failed: 0 });
    if (inFlightSyncRef.current) {
      // Join instead of dropping the call: the caller's write may have missed
      // the running pass, so the run checks for it before settling.
      rerunRequestedRef.current = true;
      return inFlightSyncRef.current;
    }

    const session = sessionRef.current;
    const isCurrentSession = () => sessionRef.current === session;

    const runPass = async (): Promise<SyncPassOutcome> => {
      let uploadResult: UploadResult = { uploaded: 0, failed: 0 };
      try {
        // Upload any queued attachments before syncing metadata
        uploadResult = await processPendingUploads();

        const result = await measureAsync("sync", () => syncDatabase(database));
        if (!isCurrentSession()) return { ok: false, pending: false, uploadResult };
        retryCountRef.current = 0;
        setLastSyncedAt(new Date());
        setLastSyncError(null);
        const pending = await checkPendingChanges();
        // The session can end during any await; a stale pass reports nothing.
        if (!isCurrentSession()) return { ok: false, pending: false, uploadResult };

        if (result.remoteChangeCount > 0) {
          const msg =
            result.remoteChangeCount === 1
              ? "A note was updated from another device"
              : `${result.remoteChangeCount} items were updated from another device`;
          showToast(msg, "warning");
        }
        return { ok: true, pending, uploadResult };
      } catch (err) {
        if (!isCurrentSession()) return { ok: false, pending: false, uploadResult };
        setLastSyncError(describeSyncError(err));
        if (err instanceof SyncNetworkError) {
          // Network error — schedule retry with backoff
          const retryIndex = Math.min(retryCountRef.current, RETRY_DELAYS_MS.length - 1);
          const delay = RETRY_DELAYS_MS[retryIndex];
          retryCountRef.current += 1;

          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            sync();
          }, delay);
        } else {
          console.error("Sync failed:", err);
        }
        await checkPendingChanges();
        return { ok: false, pending: true, uploadResult };
      }
    };

    const run = (async (): Promise<UploadResult> => {
      setIsSyncing(true);
      const total: UploadResult = { uploaded: 0, failed: 0 };
      let followUps = 0;
      try {
        for (;;) {
          rerunRequestedRef.current = false;
          editedDuringSyncRef.current = false;
          const pass = await runPass();
          total.uploaded += pass.uploadResult.uploaded;
          total.failed += pass.uploadResult.failed;
          // A run whose session has ended stops before touching the flags
          // below: they belong to the new session's run now.
          if (!isCurrentSession()) break;
          // A failed pass ends the run: the retry timer (network) or the next
          // trigger tries again, rather than this loop hammering a failure.
          // Not rescheduling here is also what keeps a partly failed push from
          // looping on the notes it re-pulls every pass.
          if (!pass.ok || !identityReadyRef.current) break;
          const missedWrite = rerunRequestedRef.current || editedDuringSyncRef.current;
          if (missedWrite && pass.pending && followUps < MAX_FOLLOW_UP_PASSES) {
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
      return total;
    })();
    inFlightSyncRef.current = run;
    return run;
  }, [checkPendingChanges, scheduleLocalEditSync, showToast]);

  // Local edits schedule their own sync (ADR-0048): this pushes a write once
  // edits pause, so screens don't have to.
  const syncLocalEdits = useCallback(async () => {
    if (!identityReadyRef.current) return;
    const pending = await checkPendingChanges();
    if (pending && isOnlineRef.current && identityReadyRef.current) {
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
      // Shown as pending before its sync starts, on a shorter debounce of its
      // own, and also while a sync runs: that sync may not push this edit.
      schedulePendingRefresh();
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
      if (pendingRefreshTimerRef.current) {
        clearTimeout(pendingRefreshTimerRef.current);
        pendingRefreshTimerRef.current = null;
      }
    };
  }, [scheduleLocalEditSync, schedulePendingRefresh]);

  // Initial sync when user logs in. The cross-account identity guard runs first
  // (and may reset the local DB) so no sync — the initial one, the periodic /
  // foreground / reconnect / local-edit triggers, or the context-exposed sync()
  // the UI calls — ever pushes or surfaces another user's local data. sync()
  // checks identityReadyRef itself, which is what covers the UI callers that are
  // already interactive while the guard is resolving. If the guard reports
  // "unsafe" it could not clear the previous user's records, so every sync
  // trigger stays parked until a later launch retries the guard successfully.
  // Keyed on the user id, not the user object: a token refresh hands out a new
  // object for the same user, which must not re-run the guard.
  useEffect(() => {
    let cancelled = false;
    if (userId) {
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
        sync();
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
      if (pendingRefreshTimerRef.current) {
        clearTimeout(pendingRefreshTimerRef.current);
        pendingRefreshTimerRef.current = null;
      }
      // End this session's sync state. A sync still running for the previous
      // user settles in the background without being joined by the next one
      // or reporting into its UI (db/sync.ts's resetSyncState does the same
      // for the module-level latch). Neither does a pending check it started.
      sessionRef.current += 1;
      pendingCheckRef.current += 1;
      inFlightSyncRef.current = null;
      rerunRequestedRef.current = false;
      editedDuringSyncRef.current = false;
      setIsSyncing(false);
      setLastSyncError(null);
    };
  }, [userId, sync]);

  // Periodic sync for pending changes
  useEffect(() => {
    periodicTimerRef.current = setInterval(async () => {
      if (!userId || !identityReadyRef.current) return;
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
  }, [sync, userId]);

  // Sync when app comes to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && userId && identityReadyRef.current) {
        sync();
      }
    });
    return () => subscription.remove();
  }, [sync, userId]);

  // Track connectivity for the local-edit trigger, and sync when the network
  // reconnects
  useEffect(() => {
    let wasDisconnected = false;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const isConnected = state.isConnected ?? false;
      isOnlineRef.current = isConnected;
      if (!isConnected) {
        wasDisconnected = true;
      } else if (wasDisconnected && userId && identityReadyRef.current) {
        wasDisconnected = false;
        retryCountRef.current = 0;
        sync();
      }
    });
    return () => unsubscribe();
  }, [sync, userId]);

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
