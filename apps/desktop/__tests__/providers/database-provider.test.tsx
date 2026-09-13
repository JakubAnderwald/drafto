import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react-native";

import { syncDatabase } from "@/db/sync";
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
    mockUseAuth.mockReturnValue({ user: TEST_USER });
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
