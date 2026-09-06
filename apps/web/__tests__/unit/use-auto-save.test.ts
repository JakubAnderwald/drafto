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
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updated_at: "2026-04-11T12:00:00Z" }),
    });
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

  it("returns lastSavedAt from API response after save", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updated_at: "2026-04-11T15:30:00Z" }),
    });

    const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

    expect(result.current.lastSavedAt).toBeNull();

    act(() => {
      result.current.debouncedSave({ title: "Test" });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.lastSavedAt).toBe("2026-04-11T15:30:00Z");
  });

  it("sets error status when response is not ok", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    });

    const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

    act(() => {
      result.current.debouncedSave({ title: "Test" });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.saveStatus).toBe("error");
    expect(result.current.lastSavedAt).toBeNull();
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
  // --- dirty tracking + cancellation (external-change reconciliation) ---
  //
  // The editor panel uses these two to decide whether an incoming external change
  // may be applied silently or has to be offered to the user, so the transitions
  // matter as much as the final state.

  describe("hasPendingChanges", () => {
    it("starts clean", () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      expect(result.current.hasPendingChanges).toBe(false);
    });

    it("goes dirty as soon as an edit is queued, before the debounce fires", () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      act(() => {
        result.current.debouncedSave({ title: "Half-typed" });
      });

      expect(result.current.hasPendingChanges).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("goes clean again once the save lands", async () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      act(() => {
        result.current.debouncedSave({ title: "Done" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.hasPendingChanges).toBe(false);
      expect(result.current.saveStatus).toBe("saved");
    });

    it("stays dirty when an edit is queued while a save is in flight", async () => {
      let release: (() => void) | undefined;
      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                ok: true,
                json: () => Promise.resolve({ updated_at: "2026-04-11T12:00:00Z" }),
              });
          }),
      );
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      act(() => {
        result.current.debouncedSave({ title: "First" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // The PATCH is airborne; the user keeps typing.
      act(() => {
        result.current.debouncedSave({ title: "Second" });
      });
      await act(async () => {
        release?.();
      });

      expect(result.current.hasPendingChanges).toBe(true);
    });
  });

  describe("cancelPendingSave", () => {
    it("drops queued edits so they cannot land after a reload from the server", async () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      act(() => {
        result.current.debouncedSave({ title: "Local edit to discard" });
      });
      act(() => {
        result.current.cancelPendingSave();
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.hasPendingChanges).toBe(false);
    });

    it("is safe to call when there is nothing queued", () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      act(() => {
        result.current.cancelPendingSave();
      });

      expect(result.current.hasPendingChanges).toBe(false);
    });

    it("does not flush the cancelled edit on unmount", async () => {
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );

      act(() => {
        result.current.debouncedSave({ title: "Discarded" });
      });
      act(() => {
        result.current.cancelPendingSave();
      });
      unmount();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("lastSavedAt", () => {
    it("exposes the server timestamp of the latest save so sync can suppress its echo", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ updated_at: "2026-09-06T12:30:00.000+00:00" }),
      });
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      act(() => {
        result.current.debouncedSave({ title: "Saved" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.lastSavedAt).toBe("2026-09-06T12:30:00.000+00:00");
    });
  });
});
