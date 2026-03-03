import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

// Mock handleAuthError to avoid window.location issues in tests
vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: vi.fn((res: { status: number }) => res.status === 401),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { useAutoSave } = await import("@/hooks/use-auto-save");

describe("useAutoSave — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("guards against concurrent saves with in-flight request", async () => {
    // Create a controllable promise for the first save
    let resolveFirst: (value: { ok: boolean; status: number }) => void;
    const firstSavePromise = new Promise<{ ok: boolean; status: number }>((resolve) => {
      resolveFirst = resolve;
    });

    mockFetch
      .mockReturnValueOnce(firstSavePromise)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

    // Trigger first save
    act(() => {
      result.current.debouncedSave({ title: "First" });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    // First save is in-flight, trigger another
    act(() => {
      result.current.debouncedSave({ title: "Second" });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    // Only one fetch should have been made so far (the first)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Resolve the first save — this should trigger the queued save
    await act(async () => {
      resolveFirst!({ ok: true, status: 200 });
    });

    // Allow microtasks to process
    await act(async () => {
      await Promise.resolve();
    });

    // Second save should now have been triggered
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/api/notes/note-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Second" }),
      }),
    );
  });

  it("sets error status on 401 and triggers auth redirect", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

    act(() => {
      result.current.debouncedSave({ title: "Test" });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.saveStatus).toBe("error");
  });

  it("merges data from multiple rapid saves", async () => {
    const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

    act(() => {
      result.current.debouncedSave({ title: "Updated Title" });
      result.current.debouncedSave({ content: [{ type: "paragraph" }] });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/notes/note-1",
      expect.objectContaining({
        body: JSON.stringify({ title: "Updated Title", content: [{ type: "paragraph" }] }),
      }),
    );
  });
});

// --- Notes API title validation ---

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

const approvedProfile = {
  select: () => ({
    eq: () => ({
      single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
    }),
  }),
};

describe("Notes API — title validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" } },
      error: null,
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: "note-1", title: "x" }, error: null }),
              }),
            }),
          }),
        }),
      };
    });
  });

  it("rejects titles longer than 255 characters", async () => {
    const longTitle = "a".repeat(256);

    const { PATCH } = await import("@/app/api/notes/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
      method: "PATCH",
      body: JSON.stringify({ title: longTitle }),
      headers: { "Content-Type": "application/json" },
    });
    const params = Promise.resolve({ id: "note-1" });
    const response = await PATCH(request, { params });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain("255");
  });

  it("accepts titles within 255 characters", async () => {
    const validTitle = "a".repeat(255);

    const { PATCH } = await import("@/app/api/notes/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
      method: "PATCH",
      body: JSON.stringify({ title: validTitle }),
      headers: { "Content-Type": "application/json" },
    });
    const params = Promise.resolve({ id: "note-1" });
    const response = await PATCH(request, { params });
    expect(response.status).toBe(200);
  });

  it("rejects non-string titles", async () => {
    const { PATCH } = await import("@/app/api/notes/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
      method: "PATCH",
      body: JSON.stringify({ title: 12345 }),
      headers: { "Content-Type": "application/json" },
    });
    const params = Promise.resolve({ id: "note-1" });
    const response = await PATCH(request, { params });
    expect(response.status).toBe(400);
  });
});
