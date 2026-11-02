import React from "react";
import { hasUnsyncedChanges } from "@nozbe/watermelondb/sync";
import NetInfo from "@react-native-community/netinfo";
import { renderHook, act, waitFor } from "@testing-library/react-native";

import { syncDatabase } from "@/db/sync";
import { processPendingUploads } from "@/lib/data/attachment-queue";
import { ensureLocalIdentity } from "@/lib/data/local-identity";
import { useAuth } from "@/providers/auth-provider";
import {
  AUTO_SYNC_DEBOUNCE_MS,
  DatabaseProvider,
  PENDING_REFRESH_DEBOUNCE_MS,
  useDatabase,
} from "@/providers/database-provider";

jest.mock("@nozbe/watermelondb", () => ({
  Q: { where: jest.fn(), notEq: jest.fn() },
}));

jest.mock("@nozbe/watermelondb/sync", () => ({
  hasUnsyncedChanges: jest.fn().mockResolvedValue(false),
}));

// Subscribers to database.withChangesForTables(), so a test can emit the
// changes a local write (or a sync's own writes) would produce.
const mockChangeListeners: ((changes: unknown[] | null) => void)[] = [];
// What the pending count reads, per table: unpushed records (fetchCount) and
// local deletions (the adapter's deleted IDs, which queries leave out).
const mockDirtyCounts = new Map<string, number>();
const mockDeletedIds = new Map<string, string[]>();

jest.mock("@/db", () => ({
  database: {
    get: jest.fn((table: string) => ({
      query: jest.fn(() => ({
        fetchCount: jest.fn(async () => mockDirtyCounts.get(table) ?? 0),
      })),
    })),
    adapter: {
      getDeletedRecords: jest.fn(async (table: string) => mockDeletedIds.get(table) ?? []),
    },
    withChangesForTables: jest.fn(() => ({
      subscribe: (listener: (changes: unknown[] | null) => void) => {
        mockChangeListeners.push(listener);
        return {
          unsubscribe: () => {
            mockChangeListeners.splice(mockChangeListeners.indexOf(listener), 1);
          },
        };
      },
    })),
  },
}));

jest.mock("@/db/sync", () => {
  class SyncNetworkError extends Error {}
  return { syncDatabase: jest.fn(), SyncNetworkError };
});

jest.mock("@/lib/data/attachment-queue", () => ({
  processPendingUploads: jest.fn(),
}));

jest.mock("@/lib/data/local-identity", () => ({
  ensureLocalIdentity: jest.fn(),
}));

jest.mock("@/lib/performance", () => ({
  measureAsync: jest.fn((_label: string, work: () => unknown) => work()),
}));

jest.mock("@/providers/auth-provider", () => ({
  useAuth: jest.fn(),
}));

// Stable identity: showToast is a dependency of the provider's sync useCallback,
// so a fresh function per render would re-run the initial-sync effect forever.
const mockShowToast = jest.fn();

jest.mock("@/components/toast", () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const mockSyncDatabase = syncDatabase as jest.Mock;
const mockProcessPendingUploads = processPendingUploads as jest.Mock;
const mockEnsureLocalIdentity = ensureLocalIdentity as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

function wrapper({ children }: { children: React.ReactNode }) {
  return <DatabaseProvider>{children}</DatabaseProvider>;
}

const TEST_USER = { id: "user-123" };

/** Lets the guard's `.then` chain settle without asserting anything happened. */
async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("DatabaseProvider cross-account sync guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: TEST_USER });
    mockSyncDatabase.mockResolvedValue({ remoteChangeCount: 0 });
    mockProcessPendingUploads.mockResolvedValue({ uploaded: 0, failed: 0 });
    mockEnsureLocalIdentity.mockResolvedValue("ready");
  });

  it("runs the identity guard before the first sync", async () => {
    renderHook(() => useDatabase(), { wrapper });

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalled());

    expect(mockEnsureLocalIdentity).toHaveBeenCalledWith("user-123");
    expect(mockEnsureLocalIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncDatabase.mock.invocationCallOrder[0],
    );
  });

  it("does not sync when the guard reports unsafe", async () => {
    mockEnsureLocalIdentity.mockResolvedValue("unsafe");
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useDatabase(), { wrapper });

    await waitFor(() => expect(mockEnsureLocalIdentity).toHaveBeenCalled());
    await flushEffects();

    expect(mockSyncDatabase).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("parks the context-exposed sync() while the guard reports unsafe", async () => {
    // Regression: the guard used to gate only the periodic / foreground /
    // reconnect triggers. The sync() on the context is what the UI drives —
    // autosave, pull to refresh, the manual sync button — so leaving it ungated
    // let a single keystroke push the previous user's rows under this session.
    mockEnsureLocalIdentity.mockResolvedValue("unsafe");
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useDatabase(), { wrapper });

    await waitFor(() => expect(mockEnsureLocalIdentity).toHaveBeenCalled());
    await flushEffects();

    let uploadResult;
    await act(async () => {
      uploadResult = await result.current.sync();
    });

    expect(mockSyncDatabase).not.toHaveBeenCalled();
    expect(mockProcessPendingUploads).not.toHaveBeenCalled();
    expect(uploadResult).toEqual({ uploaded: 0, failed: 0 });
    errorSpy.mockRestore();
  });

  it("parks a UI-triggered sync fired while the guard is still resolving", async () => {
    // RouteGuard renders inside DatabaseProvider, so screens are interactive
    // before ensureLocalIdentity settles.
    let resolveGuard: (status: string) => void = () => {};
    mockEnsureLocalIdentity.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveGuard = resolve;
      }),
    );

    const { result } = renderHook(() => useDatabase(), { wrapper });

    await act(async () => {
      await result.current.sync();
    });
    expect(mockSyncDatabase).not.toHaveBeenCalled();

    await act(async () => {
      resolveGuard("ready");
    });

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalled());
  });

  it("runs the context-exposed sync() once the guard reports ready", async () => {
    const { result } = renderHook(() => useDatabase(), { wrapper });

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalled());
    mockSyncDatabase.mockClear();

    await act(async () => {
      await result.current.sync();
    });

    expect(mockSyncDatabase).toHaveBeenCalled();
  });

  it("does not run the guard or sync when no user is signed in", async () => {
    mockUseAuth.mockReturnValue({ user: null });

    const { result } = renderHook(() => useDatabase(), { wrapper });

    await flushEffects();

    await act(async () => {
      await result.current.sync();
    });

    expect(mockEnsureLocalIdentity).not.toHaveBeenCalled();
    expect(mockSyncDatabase).not.toHaveBeenCalled();
  });
});

describe("DatabaseProvider sync scheduling (ADR-0048)", () => {
  const mockHasUnsyncedChanges = hasUnsyncedChanges as jest.Mock;
  const mockNetInfoAddEventListener = NetInfo.addEventListener as jest.Mock;
  let netInfoListener: ((state: { isConnected: boolean | null }) => void) | undefined;

  type Change = { table: string; type: string; syncStatus: string };
  /** What a user's write produces: a record that still has to be pushed. */
  const LOCAL_EDIT: Change[] = [{ table: "notes", type: "updated", syncStatus: "updated" }];
  /** What a sync's own writes produce (pulled records, markAsSynced). */
  const SYNC_WRITE: Change[] = [{ table: "notes", type: "updated", syncStatus: "synced" }];
  /** The upload queue recording an attachment's upload status. */
  const UPLOAD_STATUS: Change[] = [
    { table: "attachments", type: "updated", syncStatus: "updated" },
  ];
  /** What a local deletion (markAsDeleted) produces. */
  const LOCAL_DELETE: Change[] = [{ table: "notes", type: "destroyed", syncStatus: "deleted" }];

  function emitChanges(changes: Change[] | null): void {
    const payload =
      changes &&
      changes.map(({ table, type, syncStatus }) => ({ type, record: { table, syncStatus } }));
    for (const listener of [...mockChangeListeners]) listener(payload);
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  /** Waits for the login sync to finish completely. */
  async function settleInitialSync(result: {
    current: ReturnType<typeof useDatabase>;
  }): Promise<void> {
    await waitFor(() => expect(result.current.lastSyncedAt).not.toBeNull());
    await waitFor(() => expect(result.current.isSyncing).toBe(false));
  }

  /** Whether anything is left to push, as the pending checks would see it. */
  function hasUnpushedRecords(): boolean {
    return (
      [...mockDirtyCounts.values()].some((count) => count > 0) ||
      [...mockDeletedIds.values()].some((ids) => ids.length > 0)
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: TEST_USER });
    mockSyncDatabase.mockResolvedValue({ remoteChangeCount: 0 });
    mockProcessPendingUploads.mockResolvedValue({ uploaded: 0, failed: 0 });
    mockEnsureLocalIdentity.mockResolvedValue("ready");
    mockHasUnsyncedChanges.mockResolvedValue(false);
    mockDirtyCounts.clear();
    mockDeletedIds.clear();
    netInfoListener = undefined;
    mockNetInfoAddEventListener.mockImplementation(
      (listener: (state: { isConnected: boolean | null }) => void) => {
        netInfoListener = listener;
        return jest.fn();
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    mockHasUnsyncedChanges.mockResolvedValue(false);
    mockNetInfoAddEventListener.mockImplementation(() => jest.fn());
  });

  it("joins a running sync, then runs one more pass and reports every pass's uploads", async () => {
    const first = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(first.promise);
    mockProcessPendingUploads
      .mockResolvedValueOnce({ uploaded: 1, failed: 0 })
      .mockResolvedValueOnce({ uploaded: 0, failed: 1 });
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    // Previously dropped (it returned at once while a sync ran).
    const joined = result.current.sync();
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
    // The caller's write missed the running pass, so it is still pending.
    mockHasUnsyncedChanges.mockResolvedValueOnce(true);

    await act(async () => {
      first.resolve({ remoteChangeCount: 0 });
      await expect(joined).resolves.toEqual({ uploaded: 1, failed: 1 });
    });
    expect(mockSyncDatabase).toHaveBeenCalledTimes(2);
    expect(result.current.isSyncing).toBe(false);
  });

  it("joins a running sync without another pass when nothing is left to push", async () => {
    const first = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    const joined = result.current.sync();
    await act(async () => {
      first.resolve({ remoteChangeCount: 0 });
      await joined;
    });

    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
  });

  it("pushes an edit that landed after the running pass checked for pending changes", async () => {
    jest.useFakeTimers();
    const first = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    act(() => emitChanges(LOCAL_EDIT));
    // The pass reports nothing pending, so the run ends without a follow-up...
    await act(async () => {
      first.resolve({ remoteChangeCount: 0 });
    });
    await settleInitialSync(result);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);

    // ...but the edit still goes out after the debounce.
    mockHasUnsyncedChanges.mockResolvedValue(true);
    await advance(AUTO_SYNC_DEBOUNCE_MS);
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));
  });

  it("starts a new user's sync fresh instead of joining the previous user's", async () => {
    const stale = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(stale.promise);
    const { result, rerender } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    // User A signs out while their sync is still running; user B signs in.
    mockUseAuth.mockReturnValue({ user: null });
    rerender(undefined);
    await flushEffects();
    mockUseAuth.mockReturnValue({ user: { id: "user-456" } });
    rerender(undefined);

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.lastSyncedAt).not.toBeNull());

    // A's sync failing afterwards reports nothing into B's session.
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      stale.reject(new Error("Push notes failed"));
    });
    await flushEffects();
    expect(result.current.lastSyncError).toBeNull();
    expect(result.current.isSyncing).toBe(false);
    expect(errorSpy).not.toHaveBeenCalledWith("Sync failed:", expect.anything());
    errorSpy.mockRestore();
  });

  it("pushes a local edit once edits pause for the debounce", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);
    mockHasUnsyncedChanges.mockResolvedValue(true);

    act(() => emitChanges(LOCAL_EDIT));
    await advance(AUTO_SYNC_DEBOUNCE_MS - 1);
    act(() => emitChanges(LOCAL_EDIT)); // a further edit restarts the wait
    await advance(AUTO_SYNC_DEBOUNCE_MS - 1);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);

    await advance(1);
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));
    expect(result.current.hasPendingChanges).toBe(true);
  });

  it("never schedules a sync for a sync's own writes, and stops after a clean sync", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);

    act(() => {
      emitChanges(null); // the subscription's initial emission
      emitChanges(SYNC_WRITE);
    });
    await advance(AUTO_SYNC_DEBOUNCE_MS * 2);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);

    // A local edit syncs once. That sync's own writes (and the edits it marks
    // synced) leave nothing pending, so nothing follows it.
    mockHasUnsyncedChanges
      .mockResolvedValueOnce(true) // the pending-count refresh
      .mockResolvedValueOnce(true); // the sync trigger's check
    mockSyncDatabase.mockImplementationOnce(async () => {
      emitChanges(SYNC_WRITE);
      return { remoteChangeCount: 0 };
    });
    act(() => emitChanges(LOCAL_EDIT));
    await advance(AUTO_SYNC_DEBOUNCE_MS);
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));

    await advance(AUTO_SYNC_DEBOUNCE_MS * 10);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(2);
  });

  it("runs one more pass for an edit made while a sync was running", async () => {
    const first = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    act(() => emitChanges(LOCAL_EDIT));
    // The running pass missed the edit, so it is still pending afterwards.
    mockHasUnsyncedChanges.mockResolvedValueOnce(true);
    await act(async () => {
      first.resolve({ remoteChangeCount: 0 });
    });

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));
    await settleInitialSync(result);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(2);
  });

  it("stops a previous user's run that finishes mid-pass, leaving the new run's follow-up alone", async () => {
    // A's pass is still checking for pending changes when B signs in.
    const aPendingCheck = deferred<boolean>();
    mockHasUnsyncedChanges.mockReturnValueOnce(aPendingCheck.promise);
    const { result, rerender } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockHasUnsyncedChanges).toHaveBeenCalledTimes(1));

    mockUseAuth.mockReturnValue({ user: null });
    rerender(undefined);
    await flushEffects();
    const bSync = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(bSync.promise);
    mockUseAuth.mockReturnValue({ user: { id: "user-456" } });
    rerender(undefined);
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));

    // B's screen joins B's run, asking for another pass.
    const joined = result.current.sync();
    // A's pass now finishes with changes pending. It must not act on B's
    // request (which would start a pass for A and clear B's flags).
    await act(async () => {
      aPendingCheck.resolve(true);
    });
    await flushEffects();
    expect(mockSyncDatabase).toHaveBeenCalledTimes(2);
    // Nor does A's pending check report into B's session.
    expect(result.current.hasPendingChanges).toBe(false);

    // B's run still honours its own follow-up.
    mockHasUnsyncedChanges.mockResolvedValueOnce(true);
    await act(async () => {
      bSync.resolve({ remoteChangeCount: 0 });
      await joined;
    });
    expect(mockSyncDatabase).toHaveBeenCalledTimes(3);
  });

  it("still pushes a local edit when the pending check itself fails", async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);

    // Every check fails: the pending-count refresh, then the sync trigger's.
    mockHasUnsyncedChanges.mockRejectedValue(new Error("adapter unavailable"));
    act(() => emitChanges(LOCAL_EDIT));
    await advance(AUTO_SYNC_DEBOUNCE_MS);

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));
    expect(warnSpy).toHaveBeenCalledWith(
      "[DatabaseProvider] Could not check pending changes:",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("does not push local edits while offline, but still counts them", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);

    act(() => netInfoListener?.({ isConnected: false }));
    mockHasUnsyncedChanges.mockResolvedValue(true);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(AUTO_SYNC_DEBOUNCE_MS);

    await waitFor(() => expect(result.current.hasPendingChanges).toBe(true));
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed sync, skips the requested extra pass, and clears it on success", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const failing = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(failing.promise);
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    const joined = result.current.sync();
    await act(async () => {
      failing.reject(new Error("Push attachments (create) failed: row-level security"));
      await joined;
    });

    expect(result.current.lastSyncError).toBe(
      "Push attachments (create) failed: row-level security",
    );
    // A failing pass is not repeated back to back.
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.lastSyncError).toBeNull();
    errorSpy.mockRestore();
  });

  it("shows the toast only for remote changes the user can see", async () => {
    mockSyncDatabase.mockResolvedValueOnce({ remoteChangeCount: 0 });
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);
    expect(mockShowToast).not.toHaveBeenCalled();

    mockSyncDatabase.mockResolvedValueOnce({ remoteChangeCount: 2 });
    await act(async () => {
      await result.current.sync();
    });
    expect(mockShowToast).toHaveBeenCalledWith(
      "2 items were updated from another device",
      "warning",
    );
  });

  it("keys the identity guard on the user id, not the user object", async () => {
    const { result, rerender } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);

    // A token refresh hands out a new user object for the same user.
    mockUseAuth.mockReturnValue({ user: { id: TEST_USER.id } });
    rerender(undefined);
    await flushEffects();

    expect(mockEnsureLocalIdentity).toHaveBeenCalledTimes(1);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
  });
  it("shows a local edit as pending before its sync runs", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);
    expect(result.current.hasPendingChanges).toBe(false);

    mockHasUnsyncedChanges.mockResolvedValue(true);
    mockDirtyCounts.set("notes", 1);
    mockDirtyCounts.set("attachments", 1);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(PENDING_REFRESH_DEBOUNCE_MS);

    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.pendingChangesCount).toBe(2);
    // Only the login sync has run: the edit's own sync is still debounced.
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
    expect(result.current.isSyncing).toBe(false);
  });

  it("clears the pending state once the edit's sync succeeds", async () => {
    jest.useFakeTimers();
    mockHasUnsyncedChanges.mockImplementation(async () => hasUnpushedRecords());
    mockSyncDatabase.mockImplementation(async () => {
      // The push marks every local change synced.
      mockDirtyCounts.clear();
      mockDeletedIds.clear();
      return { remoteChangeCount: 0 };
    });
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);

    mockDirtyCounts.set("notes", 1);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(PENDING_REFRESH_DEBOUNCE_MS);
    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.pendingChangesCount).toBe(1);

    await advance(AUTO_SYNC_DEBOUNCE_MS - PENDING_REFRESH_DEBOUNCE_MS);
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isSyncing).toBe(false));
    expect(result.current.hasPendingChanges).toBe(false);
    expect(result.current.pendingChangesCount).toBe(0);
  });

  it("counts a local deletion, which queries leave out, as pending", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);

    mockHasUnsyncedChanges.mockResolvedValue(true);
    mockDeletedIds.set("notes", ["note-1"]);
    act(() => emitChanges(LOCAL_DELETE));
    await advance(PENDING_REFRESH_DEBOUNCE_MS);

    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.pendingChangesCount).toBe(1);
  });

  it("runs one pending check for a burst of edits, not one per edit", async () => {
    // Autosave writes are already 500 ms apart; a shorter wait would count more often.
    expect(PENDING_REFRESH_DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);
    mockHasUnsyncedChanges.mockClear();
    mockHasUnsyncedChanges.mockResolvedValue(true);

    act(() => emitChanges(LOCAL_EDIT));
    await advance(PENDING_REFRESH_DEBOUNCE_MS - 1);
    act(() => emitChanges(LOCAL_EDIT)); // a further edit restarts the wait
    await advance(PENDING_REFRESH_DEBOUNCE_MS - 1);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(PENDING_REFRESH_DEBOUNCE_MS - 1);
    expect(mockHasUnsyncedChanges).not.toHaveBeenCalled();

    await advance(1);
    expect(mockHasUnsyncedChanges).toHaveBeenCalledTimes(1);
    expect(result.current.hasPendingChanges).toBe(true);
  });

  it("refreshes the pending count for an edit made while a sync runs", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);

    const running = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(running.promise);
    let syncing: Promise<unknown> = Promise.resolve();
    act(() => {
      syncing = result.current.sync();
    });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));

    mockHasUnsyncedChanges.mockResolvedValue(true);
    mockDirtyCounts.set("notes", 1);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(PENDING_REFRESH_DEBOUNCE_MS);

    expect(result.current.isSyncing).toBe(true);
    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.pendingChangesCount).toBe(1);

    await act(async () => {
      running.resolve({ remoteChangeCount: 0 });
      await syncing;
    });
  });

  it("does not refresh the pending count for a sync's own writes or upload-status updates", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);
    mockHasUnsyncedChanges.mockClear();

    act(() => {
      emitChanges(null); // the subscription's initial emission
      emitChanges(SYNC_WRITE);
      emitChanges(UPLOAD_STATUS);
    });
    await advance(AUTO_SYNC_DEBOUNCE_MS * 2);

    expect(mockHasUnsyncedChanges).not.toHaveBeenCalled();
  });

  it("does not refresh the pending count before the identity guard clears", async () => {
    jest.useFakeTimers();
    // The guard is still resolving, so the local rows may be the previous user's.
    mockEnsureLocalIdentity.mockReturnValue(deferred<string>().promise);
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await flushEffects();

    mockHasUnsyncedChanges.mockResolvedValue(true);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(AUTO_SYNC_DEBOUNCE_MS * 2);

    expect(mockHasUnsyncedChanges).not.toHaveBeenCalled();
    expect(result.current.hasPendingChanges).toBe(false);
  });

  it("does not let a slow pending check overwrite a newer one", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);
    mockDirtyCounts.set("notes", 1);

    // A first edit shows as pending...
    mockHasUnsyncedChanges.mockResolvedValueOnce(true);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(PENDING_REFRESH_DEBOUNCE_MS);
    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.pendingChangesCount).toBe(1);

    // ...a second edit's refresh reads it as unpushed, but its read is slow...
    const slowCheck = deferred<boolean>();
    mockHasUnsyncedChanges.mockReturnValueOnce(slowCheck.promise);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(PENDING_REFRESH_DEBOUNCE_MS);

    // ...and a sync that pushes both edits checks again and reports first.
    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.hasPendingChanges).toBe(false);
    expect(result.current.pendingChangesCount).toBe(0);

    // The slow check's stale reading (pending, 1) is dropped.
    await act(async () => {
      slowCheck.resolve(true);
    });
    await flushEffects();

    expect(result.current.hasPendingChanges).toBe(false);
    expect(result.current.pendingChangesCount).toBe(0);
  });

  it("removes the change subscription and the pending refresh on unmount", async () => {
    jest.useFakeTimers();
    const { result, unmount } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);
    expect(mockChangeListeners).toHaveLength(1);
    mockHasUnsyncedChanges.mockClear();

    act(() => emitChanges(LOCAL_EDIT));
    unmount();
    expect(mockChangeListeners).toHaveLength(0);
    await advance(AUTO_SYNC_DEBOUNCE_MS * 2);

    expect(mockHasUnsyncedChanges).not.toHaveBeenCalled();
  });
});
