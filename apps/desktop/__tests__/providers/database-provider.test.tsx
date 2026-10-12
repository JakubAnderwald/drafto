import React from "react";
import { AppState } from "react-native";
import type { AppStateStatus, NativeEventSubscription } from "react-native";
import { hasUnsyncedChanges } from "@nozbe/watermelondb/sync";
import NetInfo from "@react-native-community/netinfo";
import { renderHook, act, waitFor } from "@testing-library/react-native";

import { syncDatabase, SyncNetworkError } from "@/db/sync";
import { processPendingUploads, cleanupOrphanedFiles, ensureLocalIdentity } from "@/lib/data";
import { useAuth } from "@/providers/auth-provider";
import {
  AUTO_SYNC_DEBOUNCE_MS,
  DatabaseProvider,
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

jest.mock("@/db", () => ({
  database: {
    get: jest.fn(() => ({
      query: jest.fn(() => ({ fetchCount: jest.fn().mockResolvedValue(0) })),
    })),
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

jest.mock("@/lib/data", () => ({
  processPendingUploads: jest.fn(),
  cleanupOrphanedFiles: jest.fn(),
  ensureLocalIdentity: jest.fn(),
}));

jest.mock("@/lib/performance", () => ({
  measureAsync: jest.fn((_label: string, work: () => unknown) => work()),
}));

jest.mock("@/providers/auth-provider", () => ({
  useAuth: jest.fn(),
}));

const mockSyncDatabase = syncDatabase as jest.Mock;
const mockProcessPendingUploads = processPendingUploads as jest.Mock;
const mockCleanupOrphanedFiles = cleanupOrphanedFiles as jest.Mock;
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
    mockUseAuth.mockReturnValue({ user: TEST_USER, isApproved: true });
    mockSyncDatabase.mockResolvedValue({ remoteChangeCount: 0 });
    mockProcessPendingUploads.mockResolvedValue(0);
    mockCleanupOrphanedFiles.mockResolvedValue(undefined);
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
    // the manual sync button and the attachment picker — so leaving it ungated
    // let the UI push the previous user's rows under this session.
    mockEnsureLocalIdentity.mockResolvedValue("unsafe");
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useDatabase(), { wrapper });

    await waitFor(() => expect(mockEnsureLocalIdentity).toHaveBeenCalled());
    await flushEffects();

    await act(async () => {
      await result.current.sync();
    });

    expect(mockSyncDatabase).not.toHaveBeenCalled();
    expect(mockProcessPendingUploads).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("parks a UI-triggered sync fired while the guard is still resolving", async () => {
    // The window is interactive before ensureLocalIdentity settles.
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
    mockUseAuth.mockReturnValue({ user: null, isApproved: false });

    const { result } = renderHook(() => useDatabase(), { wrapper });

    await flushEffects();

    await act(async () => {
      await result.current.sync();
    });

    expect(mockEnsureLocalIdentity).not.toHaveBeenCalled();
    expect(mockSyncDatabase).not.toHaveBeenCalled();
  });
});

describe("DatabaseProvider approval gating", () => {
  const mockHasUnsyncedChanges = hasUnsyncedChanges as jest.Mock;
  const mockNetInfoAddEventListener = NetInfo.addEventListener as jest.Mock;
  // Already a jest.fn from the react-native jest preset, shared by every test in
  // this file. jest.spyOn would hand back that same mock and mockRestore() would
  // wipe its implementation, so save and re-apply the preset's instead.
  const mockAppStateAddEventListener = AppState.addEventListener as unknown as jest.Mock;
  let presetAppStateImpl: ReturnType<jest.Mock["getMockImplementation"]>;
  let appStateListener: ((state: AppStateStatus) => void) | undefined;
  let netInfoListener: ((state: { isConnected: boolean | null }) => void) | undefined;

  function signInAs(isApproved: boolean) {
    mockUseAuth.mockReturnValue({ user: TEST_USER, isApproved });
  }

  /** Fires every trigger other than the initial-login sync: periodic, foreground, reconnect. */
  async function fireBackgroundTriggers(): Promise<void> {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      appStateListener?.("active");
      netInfoListener?.({ isConnected: false });
      netInfoListener?.({ isConnected: true });
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    signInAs(false);
    mockSyncDatabase.mockResolvedValue({ remoteChangeCount: 0 });
    mockProcessPendingUploads.mockResolvedValue(0);
    mockCleanupOrphanedFiles.mockResolvedValue(undefined);
    mockEnsureLocalIdentity.mockResolvedValue("ready");
    // Pending changes exist, so the periodic tick would sync if it were allowed to.
    mockHasUnsyncedChanges.mockResolvedValue(true);
    appStateListener = undefined;
    netInfoListener = undefined;
    presetAppStateImpl = mockAppStateAddEventListener.getMockImplementation();
    mockAppStateAddEventListener.mockImplementation(
      (_type: string, listener: (state: AppStateStatus) => void): NativeEventSubscription => {
        appStateListener = listener;
        return { remove: jest.fn() } as unknown as NativeEventSubscription;
      },
    );
    mockNetInfoAddEventListener.mockImplementation(
      (listener: (state: { isConnected: boolean | null }) => void) => {
        netInfoListener = listener;
        return jest.fn();
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    mockAppStateAddEventListener.mockImplementation(
      presetAppStateImpl ?? (() => ({ remove: jest.fn() })),
    );
    mockHasUnsyncedChanges.mockResolvedValue(false);
    mockNetInfoAddEventListener.mockImplementation(() => jest.fn());
  });

  it("does not run the identity guard or sync for a signed-in but unapproved user", async () => {
    const { result } = renderHook(() => useDatabase(), { wrapper });

    await flushEffects();
    await act(async () => {
      await result.current.sync();
    });

    expect(mockEnsureLocalIdentity).not.toHaveBeenCalled();
    expect(mockSyncDatabase).not.toHaveBeenCalled();
  });

  it("keeps the periodic, foreground and reconnect triggers parked while unapproved", async () => {
    jest.useFakeTimers();
    renderHook(() => useDatabase(), { wrapper });
    await flushEffects();

    await fireBackgroundTriggers();

    expect(appStateListener).toBeDefined();
    expect(netInfoListener).toBeDefined();
    expect(mockHasUnsyncedChanges).not.toHaveBeenCalled();
    expect(mockSyncDatabase).not.toHaveBeenCalled();
  });

  it("runs the identity guard and the initial sync once approval arrives", async () => {
    const { rerender } = renderHook(() => useDatabase(), { wrapper });
    await flushEffects();
    expect(mockSyncDatabase).not.toHaveBeenCalled();

    signInAs(true);
    rerender(undefined);

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));
    expect(mockEnsureLocalIdentity).toHaveBeenCalledWith("user-123");
  });

  it("stops every trigger once approval is lost", async () => {
    jest.useFakeTimers();
    signInAs(true);
    const { result, rerender } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    signInAs(false);
    rerender(undefined);
    await flushEffects();
    await fireBackgroundTriggers();
    await act(async () => {
      await result.current.sync();
    });

    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
  });

  it("never syncs from a pending network retry once the user has signed out", async () => {
    jest.useFakeTimers();
    signInAs(true);
    mockSyncDatabase.mockRejectedValueOnce(new SyncNetworkError("Network request failed"));
    const { rerender } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));
    // The failed sync has finished handling its error, so the retry is scheduled.
    await waitFor(() => expect(mockHasUnsyncedChanges).toHaveBeenCalled());

    mockUseAuth.mockReturnValue({ user: null, isApproved: false });
    rerender(undefined);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });

    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
  });

  it("never syncs from a retry scheduled by a sync that fails after sign-out", async () => {
    // The sync is still in flight when the user signs out, so the effect cleanup
    // that clears pending retries has already run when it fails. Its session
    // has ended, so it schedules no retry at all; and a retry that did fire
    // would still not run (identityReadyRef and canSyncRef both stop it).
    jest.useFakeTimers();
    signInAs(true);
    let failSync: (error: Error) => void = () => {};
    mockSyncDatabase.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failSync = reject;
      }),
    );
    const { rerender } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    mockUseAuth.mockReturnValue({ user: null, isApproved: false });
    rerender(undefined);
    await act(async () => {
      failSync(new SyncNetworkError("Network request failed"));
      await Promise.resolve();
    });
    await flushEffects();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });

    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
  });

  it("still retries a network failure while the user stays signed in and approved", async () => {
    jest.useFakeTimers();
    signInAs(true);
    mockSyncDatabase.mockRejectedValueOnce(new SyncNetworkError("Network request failed"));
    renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockHasUnsyncedChanges).toHaveBeenCalled());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });

    expect(mockSyncDatabase).toHaveBeenCalledTimes(2);
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: TEST_USER, isApproved: true });
    mockSyncDatabase.mockResolvedValue({ remoteChangeCount: 0 });
    mockProcessPendingUploads.mockResolvedValue(0);
    mockCleanupOrphanedFiles.mockResolvedValue(undefined);
    mockEnsureLocalIdentity.mockResolvedValue("ready");
    mockHasUnsyncedChanges.mockResolvedValue(false);
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

  it("joins a running sync, then runs one more pass", async () => {
    const first = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));

    // Previously dropped (it returned at once while a sync ran).
    const joined = result.current.sync();
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
    // The caller's write missed the running pass, so it is still pending.
    mockHasUnsyncedChanges.mockResolvedValueOnce(true);

    await act(async () => {
      first.resolve({ remoteChangeCount: 0 });
      await joined;
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

  it("runs one more pass after an upload, so the attachment's status is pushed", async () => {
    // Uploads run after synchronize() on desktop, so the uploaded attachment
    // is dirty again until the next pass pushes it.
    mockProcessPendingUploads.mockResolvedValueOnce(1).mockResolvedValue(0);
    mockHasUnsyncedChanges.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useDatabase(), { wrapper });

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));
    await settleInitialSync(result);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(2);
    expect(result.current.hasPendingChanges).toBe(false);
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
    mockUseAuth.mockReturnValue({ user: null, isApproved: false });
    rerender(undefined);
    await flushEffects();
    mockUseAuth.mockReturnValue({ user: { id: "user-456" }, isApproved: true });
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

  it("stops a previous user's run that finishes mid-pass, leaving the new run's follow-up alone", async () => {
    // A's pass is still checking for pending changes when B signs in.
    const aPendingCheck = deferred<boolean>();
    mockHasUnsyncedChanges.mockReturnValueOnce(aPendingCheck.promise);
    const { result, rerender } = renderHook(() => useDatabase(), { wrapper });
    await waitFor(() => expect(mockHasUnsyncedChanges).toHaveBeenCalledTimes(1));

    mockUseAuth.mockReturnValue({ user: null, isApproved: false });
    rerender(undefined);
    await flushEffects();
    const bSync = deferred<{ remoteChangeCount: number }>();
    mockSyncDatabase.mockReturnValueOnce(bSync.promise);
    mockUseAuth.mockReturnValue({ user: { id: "user-456" }, isApproved: true });
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

    mockHasUnsyncedChanges.mockRejectedValueOnce(new Error("adapter unavailable"));
    act(() => emitChanges(LOCAL_EDIT));
    await advance(AUTO_SYNC_DEBOUNCE_MS);

    await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(2));
    expect(warnSpy).toHaveBeenCalledWith(
      "[DatabaseProvider] Could not check pending changes:",
      expect.any(Error),
    );
    warnSpy.mockRestore();
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
      emitChanges(UPLOAD_STATUS);
    });
    await advance(AUTO_SYNC_DEBOUNCE_MS * 2);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);

    // A local edit syncs once. That sync's own writes leave nothing pending,
    // so nothing follows it.
    mockHasUnsyncedChanges.mockResolvedValueOnce(true);
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

  it("does not loop on an upload that keeps failing after each sync", async () => {
    // Desktop uploads after synchronize(), so a failing upload leaves its
    // attachment dirty after every pass. Its status writes must not chain
    // another pass.
    mockHasUnsyncedChanges.mockResolvedValue(true);
    mockProcessPendingUploads.mockImplementation(async () => {
      emitChanges(UPLOAD_STATUS);
      return 0;
    });
    const { result } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);
    await flushEffects();

    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
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

  it("does not push local edits for an unapproved user", async () => {
    jest.useFakeTimers();
    mockUseAuth.mockReturnValue({ user: TEST_USER, isApproved: false });
    renderHook(() => useDatabase(), { wrapper });
    await flushEffects();

    mockHasUnsyncedChanges.mockResolvedValue(true);
    act(() => emitChanges(LOCAL_EDIT));
    await advance(AUTO_SYNC_DEBOUNCE_MS * 2);

    expect(mockSyncDatabase).not.toHaveBeenCalled();
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

  it("keys the identity guard on the user id, not the user object", async () => {
    const { result, rerender } = renderHook(() => useDatabase(), { wrapper });
    await settleInitialSync(result);

    // A token refresh hands out a new user object for the same user.
    mockUseAuth.mockReturnValue({ user: { id: TEST_USER.id }, isApproved: true });
    rerender(undefined);
    await flushEffects();

    expect(mockEnsureLocalIdentity).toHaveBeenCalledTimes(1);
    expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
  });
});
