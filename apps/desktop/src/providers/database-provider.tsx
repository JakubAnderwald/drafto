import { createContext, useContext, useEffect, useRef, useCallback, useState } from "react";
import { AppState } from "react-native";
import type { Database } from "@nozbe/watermelondb";
import { Q } from "@nozbe/watermelondb";
import { hasUnsyncedChanges } from "@nozbe/watermelondb/sync";
import NetInfo from "@react-native-community/netinfo";

import { database } from "@/db";
import { syncDatabase, SyncNetworkError } from "@/db/sync";
import { processPendingUploads, cleanupOrphanedFiles, ensureLocalIdentity } from "@/lib/data";
import { measureAsync } from "@/lib/performance";
import { useAuth } from "@/providers/auth-provider";

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
const PERIODIC_SYNC_MS = 30_000;

interface DatabaseContextValue {
  database: Database;
  sync: () => Promise<void>;
  hasPendingChanges: boolean;
  pendingChangesCount: number;
  lastSyncedAt: Date | null;
  isSyncing: boolean;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function DatabaseProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const syncingRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const periodicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const identityReadyRef = useRef(false);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);
  const [pendingChangesCount, setPendingChangesCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const checkPendingChanges = useCallback(async () => {
    try {
      const pending = await hasUnsyncedChanges({ database });
      setHasPendingChanges(pending);

      if (pending) {
        const tables = ["notebooks", "notes", "attachments"] as const;
        let count = 0;
        for (const table of tables) {
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
    } catch {
      console.debug("[DatabaseProvider] Error checking pending changes");
    }
  }, []);

  const sync = useCallback(async () => {
    // The cross-account identity guard gates every sync, not just the automatic
    // triggers below: this callback is what the UI drives (the manual sync
    // button, the attachment picker), and screens are interactive while
    // ensureLocalIdentity is still resolving. Syncing before it reports "ready"
    // would push the previous user's rows under this session — the leak the
    // guard exists to prevent.
    if (!identityReadyRef.current) return;
    if (syncingRef.current) return;
    syncingRef.current = true;
    setIsSyncing(true);
    try {
      const result = await measureAsync("sync", () => syncDatabase(database));
      retryCountRef.current = 0;
      setLastSyncedAt(new Date());

      // Upload any locally-queued attachments after sync
      try {
        await processPendingUploads();
      } catch (uploadErr) {
        console.error("[DatabaseProvider] Attachment upload processing failed:", uploadErr);
      }

      await checkPendingChanges();

      if (result.conflictCount > 0) {
        const msg =
          result.conflictCount === 1
            ? "A note was updated from another device"
            : `${result.conflictCount} items were updated from another device`;
        console.log(`[Sync] ${msg}`);
      }
    } catch (err) {
      if (err instanceof SyncNetworkError) {
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
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
  }, [checkPendingChanges]);

  // Initial sync when user logs in. The cross-account identity guard runs first
  // (and may reset the local DB) so no sync — the initial one, the periodic /
  // foreground / reconnect triggers, or the context-exposed sync() the UI calls
  // — ever pushes or surfaces another user's local data. sync() checks
  // identityReadyRef itself, which is what covers the UI callers that are
  // already interactive while the guard is resolving. If the guard reports
  // "unsafe" it could not clear the previous user's records, so every sync
  // trigger stays parked until a later launch retries the guard successfully.
  useEffect(() => {
    let cancelled = false;
    if (user) {
      retryCountRef.current = 0;
      identityReadyRef.current = false;
      ensureLocalIdentity(user.id).then((status) => {
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
    };
  }, [user, sync]);

  // Periodic sync for pending changes
  useEffect(() => {
    periodicTimerRef.current = setInterval(async () => {
      if (!user || !identityReadyRef.current) return;
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
  }, [sync, user]);

  // Sync when window comes to foreground
  // On macOS, AppState "active" fires when the app window gains focus
  // (maps to NSApplication.didBecomeActiveNotification)
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && user && identityReadyRef.current) {
        sync();
      }
    });
    return () => subscription.remove();
  }, [sync, user]);

  // Sync when network reconnects
  useEffect(() => {
    let wasDisconnected = false;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const isConnected = state.isConnected ?? false;
      if (!isConnected) {
        wasDisconnected = true;
      } else if (wasDisconnected && user && identityReadyRef.current) {
        wasDisconnected = false;
        retryCountRef.current = 0;
        sync();
      }
    });
    return () => unsubscribe();
  }, [sync, user]);

  return (
    <DatabaseContext.Provider
      value={{ database, sync, hasPendingChanges, pendingChangesCount, lastSyncedAt, isSyncing }}
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
