import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react-native";
import type { User } from "@supabase/supabase-js";

import { database } from "@/db";
import { syncDatabase, resetSyncState } from "@/db/sync";
import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { supabase } from "@/lib/supabase";
import * as approvalCache from "@/lib/approval-cache";
import { deleteAllLocalAttachments, processPendingUploads } from "@/lib/data";

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signOut: jest.fn(),
    },
    from: jest.fn(),
  },
}));

jest.mock("@/lib/approval-cache");

jest.mock("@/db", () => ({
  database: {
    write: jest.fn((work: () => Promise<void>) => work()),
    unsafeResetDatabase: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/db/sync", () => ({
  syncDatabase: jest.fn(),
  resetSyncState: jest.fn(),
}));

jest.mock("@/lib/data", () => ({
  processPendingUploads: jest.fn(),
  deleteAllLocalAttachments: jest.fn(),
}));

const mockSupabase = supabase as jest.Mocked<typeof supabase>;
const mockApprovalCache = approvalCache as jest.Mocked<typeof approvalCache>;
const mockDatabase = database as unknown as {
  write: jest.Mock;
  unsafeResetDatabase: jest.Mock;
};
const mockSyncDatabase = syncDatabase as jest.Mock;
const mockResetSyncState = resetSyncState as jest.Mock;
const mockProcessPendingUploads = processPendingUploads as jest.Mock;
const mockDeleteAllLocalAttachments = deleteAllLocalAttachments as jest.Mock;

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

const TEST_USER = { id: "user-123" } as unknown as User;

function mockProfileQuery(data: { is_approved: boolean } | null, error: unknown) {
  (mockSupabase.from as jest.Mock).mockReturnValue({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data, error }),
      }),
    }),
  });
}

describe("AuthProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApprovalCache.getCachedApproval.mockResolvedValue(null);
    mockApprovalCache.setCachedApproval.mockResolvedValue(undefined);
    mockApprovalCache.clearCachedApproval.mockResolvedValue(undefined);
    mockSyncDatabase.mockResolvedValue({ conflictCount: 0 });
    mockProcessPendingUploads.mockResolvedValue(0);
    mockDeleteAllLocalAttachments.mockResolvedValue(undefined);
  });

  it("loads with no session and sets isLoading false", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: null },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isApproved).toBe(false);
  });

  it("checks approval online and caches result scoped by userId", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery({ is_approved: true }, null);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isApproved).toBe(true);
    expect(mockApprovalCache.setCachedApproval).toHaveBeenCalledWith("user-123", true);
  });

  it("falls back to cached approval when network fails", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery(null, { message: "Network error", code: "NETWORK_ERROR" });
    mockApprovalCache.getCachedApproval.mockResolvedValue(true);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isApproved).toBe(true);
    expect(mockApprovalCache.getCachedApproval).toHaveBeenCalledWith("user-123");
  });

  it("clears cached approval and resets the local database on sign out", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery({ is_approved: true }, null);
    (mockSupabase.auth.signOut as jest.Mock).mockResolvedValue({});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockApprovalCache.clearCachedApproval).toHaveBeenCalledWith("user-123");
    expect(mockDatabase.unsafeResetDatabase).toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).toHaveBeenCalled();
    expect(result.current.isApproved).toBe(false);
  });

  it("attempts a final sync before destroying the Supabase session", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery({ is_approved: true }, null);
    (mockSupabase.auth.signOut as jest.Mock).mockResolvedValue({});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockProcessPendingUploads).toHaveBeenCalled();
    expect(mockSyncDatabase).toHaveBeenCalled();
    expect(mockSyncDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      (mockSupabase.auth.signOut as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("completes sign out even if the final sync fails", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery({ is_approved: true }, null);
    (mockSupabase.auth.signOut as jest.Mock).mockResolvedValue({});
    mockSyncDatabase.mockRejectedValue(new Error("network offline"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.signOut()).resolves.toBeUndefined();
    });

    expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    expect(mockDatabase.unsafeResetDatabase).toHaveBeenCalled();
    expect(result.current.isApproved).toBe(false);
    warnSpy.mockRestore();
  });

  it("completes sign out even if the local database reset fails", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery({ is_approved: true }, null);
    (mockSupabase.auth.signOut as jest.Mock).mockResolvedValue({});
    mockDatabase.unsafeResetDatabase.mockRejectedValueOnce(new Error("reset failed"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.signOut()).resolves.toBeUndefined();
    });

    expect(result.current.isApproved).toBe(false);
    errorSpy.mockRestore();
  });

  it("completes sign out even if deleting local attachments fails", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery({ is_approved: true }, null);
    (mockSupabase.auth.signOut as jest.Mock).mockResolvedValue({});
    mockDeleteAllLocalAttachments.mockRejectedValue(new Error("fs error"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.signOut()).resolves.toBeUndefined();
    });

    expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    expect(result.current.isApproved).toBe(false);
    errorSpy.mockRestore();
  });

  it("invalidates the in-flight sync on sign out", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery({ is_approved: true }, null);
    (mockSupabase.auth.signOut as jest.Mock).mockResolvedValue({});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.signOut();
    });

    // Invalidated after the session is destroyed and before the DB reset, so a
    // subsequently signed-in user can't coalesce onto this session's stale sync.
    expect(mockResetSyncState).toHaveBeenCalled();
    expect(mockResetSyncState.mock.invocationCallOrder[0]).toBeGreaterThan(
      (mockSupabase.auth.signOut as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(mockResetSyncState.mock.invocationCallOrder[0]).toBeLessThan(
      mockDatabase.unsafeResetDatabase.mock.invocationCallOrder[0],
    );
  });

  it("completes sign out even when the final sync never settles (timeout path)", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    mockProfileQuery({ is_approved: true }, null);
    (mockSupabase.auth.signOut as jest.Mock).mockResolvedValue({});
    mockProcessPendingUploads.mockResolvedValue(0);
    // A flush that never settles must not wedge sign-out — withTimeout fires.
    mockSyncDatabase.mockReturnValue(new Promise<never>(() => {}));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    jest.useFakeTimers();
    try {
      await act(async () => {
        const pending = result.current.signOut();
        // Advance past FINAL_SYNC_TIMEOUT_MS (10s) so withTimeout rejects and
        // sign-out proceeds to reset regardless of the hung flush.
        await jest.advanceTimersByTimeAsync(10_000);
        await pending;
      });
    } finally {
      jest.useRealTimers();
    }

    expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    expect(mockDatabase.unsafeResetDatabase).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
