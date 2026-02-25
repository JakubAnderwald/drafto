import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { useAutoSave } = await import("@/hooks/use-auto-save");

describe("useAutoSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with idle status", () => {
    const { result } = renderHook(() => useAutoSave({ noteId: "note-1" }));
    expect(result.current.saveStatus).toBe("idle");
  });

  it("debounces save calls", async () => {
    const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

    act(() => {
      result.current.debouncedSave({ title: "A" });
      result.current.debouncedSave({ title: "AB" });
      result.current.debouncedSave({ title: "ABC" });
    });

    // Not saved yet
    expect(mockFetch).not.toHaveBeenCalled();

    // Advance past debounce
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    // Only saved once with latest data
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/notes/note-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "ABC" }),
      }),
    );
  });

  it("flushes pending save on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useAutoSave({ noteId: "note-1", debounceMs: 1000 }),
    );

    act(() => {
      result.current.debouncedSave({ title: "Flush me" });
    });

    // Not saved yet (debounce hasn't fired)
    expect(mockFetch).not.toHaveBeenCalled();

    // Unmount before the timer fires
    unmount();

    // The flush-on-unmount path should have called fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/notes/note-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Flush me" }),
      }),
    );
  });

  it("does not save when noteId is null", async () => {
    const { result } = renderHook(() => useAutoSave({ noteId: null, debounceMs: 100 }));

    act(() => {
      result.current.debouncedSave({ title: "Test" });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
