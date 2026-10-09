import React from "react";
import { AppState } from "react-native";
import type { AppStateStatus, NativeEventSubscription } from "react-native";
import { hasUnsyncedChanges } from "@nozbe/watermelondb/sync";
import NetInfo from "@react-native-community/netinfo";
import { renderHook, act, waitFor } from "@testing-library/react-native";

import { syncDatabase, SyncNetworkError } from "@/db/sync";
import { processPendingUploads, cleanupOrphanedFiles, ensureLocalIdentity } from "@/lib/data";
import { useAuth } from "@/providers/auth-provider";
import { DatabaseProvider, useDatabase } from "@/providers/database-provider";

jest.mock("@nozbe/watermelondb", () => ({
  Q: { where: jest.fn(), notEq: jest.fn() },
}));

jest.mock("@nozbe/watermelondb/sync", () => ({
  hasUnsyncedChanges: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/db", () => ({
  database: {
    get: jest.fn(() => ({
      query: jest.fn(() => ({ fetchCount: jest.fn().mockResolvedValue(0) })),
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
    mockSyncDatabase.mockResolvedValue({ conflictCount: 0 });
    mockProcessPendingUploads.mockResolvedValue({ uploaded: 0, failed: 0 });
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
    mockSyncDatabase.mockResolvedValue({ conflictCount: 0 });
    mockProcessPendingUploads.mockResolvedValue({ uploaded: 0, failed: 0 });
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
    // that clears pending retries has already run when this retry is scheduled.
    // When it fires, sync() must still not run (identityReadyRef and canSyncRef
    // both stop it).
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
    await waitFor(() => expect(mockHasUnsyncedChanges).toHaveBeenCalled());
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
