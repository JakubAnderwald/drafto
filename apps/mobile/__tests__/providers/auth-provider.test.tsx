import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react-native";

import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { supabase } from "@/lib/supabase";
import * as approvalCache from "@/lib/approval-cache";

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

const mockSupabase = supabase as jest.Mocked<typeof supabase>;
const mockApprovalCache = approvalCache as jest.Mocked<typeof approvalCache>;

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

const TEST_USER = { id: "user-123" } as never;

describe("AuthProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApprovalCache.getCachedApproval.mockResolvedValue(null);
    mockApprovalCache.setCachedApproval.mockResolvedValue(undefined);
    mockApprovalCache.clearCachedApproval.mockResolvedValue(undefined);
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

  it("checks approval online and caches result", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    (mockSupabase.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: { is_approved: true },
            error: null,
          }),
        }),
      }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isApproved).toBe(true);
    expect(mockApprovalCache.setCachedApproval).toHaveBeenCalledWith(true);
  });

  it("falls back to cached approval when network fails", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    (mockSupabase.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: null,
            error: { message: "Network error", code: "NETWORK_ERROR" },
          }),
        }),
      }),
    });
    mockApprovalCache.getCachedApproval.mockResolvedValue(true);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isApproved).toBe(true);
    expect(mockApprovalCache.getCachedApproval).toHaveBeenCalled();
  });

  it("sets isApproved false when network fails and no cache exists", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    (mockSupabase.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: null,
            error: { message: "Network error", code: "NETWORK_ERROR" },
          }),
        }),
      }),
    });
    mockApprovalCache.getCachedApproval.mockResolvedValue(null);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isApproved).toBe(false);
  });

  it("clears cached approval on sign out", async () => {
    (mockSupabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { user: TEST_USER } },
    });
    (mockSupabase.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: { is_approved: true },
            error: null,
          }),
        }),
      }),
    });
    (mockSupabase.auth.signOut as jest.Mock).mockResolvedValue({});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockApprovalCache.clearCachedApproval).toHaveBeenCalled();
    expect(result.current.isApproved).toBe(false);
  });
});
