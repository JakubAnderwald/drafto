import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => sentry);

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { useAutoSave } = await import("@/hooks/use-auto-save");
const { flushPendingSaves } = await import("@/lib/pending-saves");

type FetchInit = { method: string; body: string; keepalive?: boolean };

function fetchInit(call: number): FetchInit {
  return mockFetch.mock.calls[call][1] as FetchInit;
}

function sentBody(call: number): unknown {
  return JSON.parse(fetchInit(call).body);
}

const okResponse = {
  ok: true,
  status: 200,
  json: () => Promise.resolve({ updated_at: "2026-04-11T12:00:00Z" }),
};

/** A fetch that stays in flight until the test settles it. */
function deferredFetch() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  mockFetch.mockImplementationOnce(
    () =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    resolve: (value: unknown) => resolve(value),
    reject: (reason: unknown) => reject(reason),
  };
}

/**
 * Fail the next send the way a real network failure does: the keepalive PATCH rejects, and
 * so does the plain-fetch retry `sendPatch` makes for a refused keepalive send.
 */
function failNextSend(error: unknown = new Error("offline")) {
  mockFetch.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

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
    expect(result.current.lastSavedTitle).toBeNull();
  });

  it("exposes the notes-full message when the content quota refuses a save, and clears it on the next success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 413,
      json: () =>
        Promise.resolve({
          error: "Note content quota exceeded",
          code: "content_quota_exceeded",
          usedBytes: 26214400,
          quotaBytes: 26214400,
        }),
    });

    const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

    act(() => {
      result.current.debouncedSave({ content: [] });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.saveStatus).toBe("error");
    expect(result.current.saveError).toBe(
      "Notes full: you've used 25 MB of your 25 MB for notes. Delete notes you no longer need and empty the trash to free space.",
    );

    act(() => {
      result.current.debouncedSave({ content: [] });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.saveStatus).toBe("saved");
    expect(result.current.saveError).toBeNull();
  });

  describe("content quota refusals", () => {
    const quotaRefusal = {
      ok: false,
      status: 413,
      json: () =>
        Promise.resolve({
          error: "Note content quota exceeded",
          code: "content_quota_exceeded",
          usedBytes: 26214400,
          quotaBytes: 26214400,
        }),
    };

    async function saveAndFlush(
      result: { current: ReturnType<typeof useAutoSave> },
      data: Record<string, unknown>,
    ) {
      act(() => {
        result.current.debouncedSave(data);
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
    }

    it("keeps the refused edit pending and sends it again with the next edit", async () => {
      mockFetch.mockResolvedValueOnce(quotaRefusal);
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { content: ["big"] });
      expect(result.current.saveStatus).toBe("error");
      expect(result.current.hasPendingChanges).toBe(true);

      await saveAndFlush(result, { title: "T" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body as string)).toEqual({
        content: ["big"],
        title: "T",
      });
      expect(result.current.saveStatus).toBe("saved");
      expect(result.current.hasPendingChanges).toBe(false);
    });

    it("lets a newer edit win over the refused one for the same field", async () => {
      mockFetch.mockResolvedValueOnce(quotaRefusal);
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { content: ["big"] });
      await saveAndFlush(result, { content: ["smaller"] });

      expect(JSON.parse(mockFetch.mock.calls[1][1].body as string)).toEqual({
        content: ["smaller"],
      });
    });

    it("doesn't retry the refused edit in a loop", async () => {
      mockFetch.mockResolvedValue(quotaRefusal);
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { content: ["big"] });
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("flushes the refused edit on unmount", async () => {
      mockFetch.mockResolvedValueOnce(quotaRefusal);
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );

      await saveAndFlush(result, { content: ["big"] });
      unmount();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body as string)).toEqual({
        content: ["big"],
      });
    });

    it("clears the notes-full message when a later save fails for another reason", async () => {
      mockFetch.mockResolvedValueOnce(quotaRefusal);
      failNextSend();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { content: ["big"] });
      expect(result.current.saveError).toMatch(/^Notes full/);

      await saveAndFlush(result, { title: "T" });
      expect(result.current.saveStatus).toBe("error");
      expect(result.current.saveError).toBeNull();
    });
  });

  it("leaves saveError null for a failure that isn't the content quota", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 413,
      json: () => Promise.resolve({ error: "File too large" }),
    });

    const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
    act(() => {
      result.current.debouncedSave({ title: "Test" });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.saveStatus).toBe("error");
    expect(result.current.saveError).toBeNull();
  });

  describe("keepalive", () => {
    it("sends the unmount flush with keepalive so it outlives the page", () => {
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 1000 }),
      );
      act(() => {
        result.current.debouncedSave({ title: "Flush me" });
      });
      unmount();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(fetchInit(0).keepalive).toBe(true);
    });

    it("sends the debounced save with keepalive too", async () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "T" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(fetchInit(0).keepalive).toBe(true);
    });

    it("uses a plain fetch for a body over the browser's keepalive cap", () => {
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 1000 }),
      );
      act(() => {
        result.current.debouncedSave({ content: "x".repeat(70 * 1024) });
      });
      unmount();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(fetchInit(0).keepalive).toBe(false);
    });

    it("keeps every keepalive body in flight under the browser's combined cap", async () => {
      const inFlight = deferredFetch();
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );
      act(() => {
        result.current.debouncedSave({ content: "x".repeat(35 * 1024) });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(fetchInit(0).keepalive).toBe(true);

      // Switching notes while that save is in flight: a second 35 KB keepalive body would
      // take the total past 64 KiB, and the browser would reject it.
      act(() => {
        result.current.debouncedSave({ title: "T" });
      });
      unmount();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(fetchInit(1).keepalive).toBe(false);
      await act(async () => {
        inFlight.resolve(okResponse);
      });
    });

    it("sends a refused keepalive PATCH again at once as a plain fetch", async () => {
      // The browser's keepalive quota is shared with the page's other requests (Sentry's
      // transport among them), so it can refuse a send that fits autosave's own budget.
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "Refused" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(fetchInit(0).keepalive).toBe(true);
      expect(fetchInit(1).keepalive).toBe(false);
      expect(sentBody(1)).toEqual({ title: "Refused" });
      expect(result.current.saveStatus).toBe("saved");
      expect(result.current.hasPendingChanges).toBe(false);
      expect(sentry.captureException).not.toHaveBeenCalled();
    });

    it("doesn't retry a plain fetch that fails", async () => {
      const error = new Error("offline");
      mockFetch.mockRejectedValueOnce(error);
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 1000 }),
      );
      act(() => {
        result.current.debouncedSave({ content: "x".repeat(70 * 1024) });
      });
      unmount();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(fetchInit(0).keepalive).toBe(false);
      expect(sentry.captureException).toHaveBeenCalledWith(error, {
        extra: { where: "unmount", noteId: "note-1" },
      });
    });

    it("reports a failed unmount flush to Sentry", async () => {
      const error = new Error("offline");
      failNextSend(error);
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 1000 }),
      );
      act(() => {
        result.current.debouncedSave({ title: "Lost?" });
      });
      unmount();
      await act(async () => {
        await Promise.resolve();
      });

      expect(sentry.captureException).toHaveBeenCalledWith(error, {
        extra: { where: "unmount", noteId: "note-1" },
      });
    });
  });

  describe("flush on page hide", () => {
    afterEach(() => {
      setVisibility("visible");
    });

    it("flushes pending data on pagehide, inside the debounce window", async () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 1000 }));
      act(() => {
        result.current.debouncedSave({ title: "Closing the tab" });
      });

      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe("/api/notes/note-1");
      expect(sentBody(0)).toEqual({ title: "Closing the tab" });
      expect(fetchInit(0).keepalive).toBe(true);

      // The debounce timer was cleared, so the edit isn't sent twice.
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.current.saveStatus).toBe("saved");
    });

    it("flushes pending data when the page becomes hidden", () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 1000 }));
      act(() => {
        result.current.debouncedSave({ title: "Switching apps" });
      });

      setVisibility("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sentBody(0)).toEqual({ title: "Switching apps" });
    });

    it("does nothing when the page becomes visible again", () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 1000 }));
      act(() => {
        result.current.debouncedSave({ title: "Back" });
      });

      setVisibility("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does nothing when there is nothing pending", () => {
      renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 1000 }));
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("removes the listeners it added on unmount", () => {
      const addWindow = vi.spyOn(window, "addEventListener");
      const addDocument = vi.spyOn(document, "addEventListener");
      const removeWindow = vi.spyOn(window, "removeEventListener");
      const removeDocument = vi.spyOn(document, "removeEventListener");
      try {
        const { unmount } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 1000 }));
        const pageHide = addWindow.mock.calls.find(([type]) => type === "pagehide")?.[1];
        const visibility = addDocument.mock.calls.find(
          ([type]) => type === "visibilitychange",
        )?.[1];
        expect(pageHide).toBeTypeOf("function");
        expect(visibility).toBeTypeOf("function");
        unmount();

        expect(removeWindow).toHaveBeenCalledWith("pagehide", pageHide);
        expect(removeDocument).toHaveBeenCalledWith("visibilitychange", visibility);
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        addWindow.mockRestore();
        addDocument.mockRestore();
        removeWindow.mockRestore();
        removeDocument.mockRestore();
      }
    });

    it("flushes to the new note only after noteId changes", () => {
      const { result, rerender } = renderHook(
        ({ noteId }) => useAutoSave({ noteId, debounceMs: 1000 }),
        { initialProps: { noteId: "note-1" } },
      );
      act(() => {
        result.current.debouncedSave({ title: "Old note" });
      });
      rerender({ noteId: "note-2" });

      // The cleanup for note-1 flushed its edit to note-1.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe("/api/notes/note-1");

      act(() => {
        result.current.debouncedSave({ title: "New note" });
      });
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toBe("/api/notes/note-2");
      expect(sentBody(1)).toEqual({ title: "New note" });
    });

    it("sends pending data straight away when a save is already in flight", async () => {
      const inFlight = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "First" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.debouncedSave({ title: "Second" });
      });
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });

      // A closing page never sees the first response, so the drain loop can't wait for it.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(sentBody(1)).toEqual({ title: "Second" });
      expect(fetchInit(1).keepalive).toBe(true);

      await act(async () => {
        inFlight.resolve(okResponse);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("keeps the newer edits when both the save in flight and the flush fail", async () => {
      const inFlight = deferredFetch();
      const flush = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "Old", content: ["old"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.debouncedSave({ title: "New" });
      });
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      // The flush carries the payload in flight under the newer edit.
      expect(sentBody(1)).toEqual({ title: "New", content: ["old"] });

      // Each keepalive send's plain-fetch retry fails too.
      mockFetch
        .mockRejectedValueOnce(new Error("offline"))
        .mockRejectedValueOnce(new Error("offline"));
      await act(async () => {
        inFlight.reject(new Error("offline"));
      });
      await act(async () => {
        flush.reject(new Error("offline"));
      });
      expect(mockFetch).toHaveBeenCalledTimes(4);

      act(() => {
        result.current.debouncedSave({ content: ["newest"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(sentBody(4)).toEqual({ title: "New", content: ["newest"] });
    });

    it("leaves a field an earlier flush re-sent with a newer value out of a later flush", async () => {
      // "A" stays in flight throughout.
      deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "A", content: ["in flight"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      act(() => {
        result.current.debouncedSave({ title: "B" });
      });
      setVisibility("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      setVisibility("visible");
      // The first flush carries the content no newer edit replaced.
      expect(sentBody(1)).toEqual({ title: "B", content: ["in flight"] });

      act(() => {
        result.current.debouncedSave({ content: ["typed"] });
      });
      setVisibility("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      // Title "A" would overwrite the "B" the first flush saved.
      expect(sentBody(2)).toEqual({ content: ["typed"] });
    });

    it("restores nothing when the save in flight fails but the flush that re-sent it lands", async () => {
      const inFlight = deferredFetch();
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );
      act(() => {
        result.current.debouncedSave({ content: ["old"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.debouncedSave({ title: "New" });
      });
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
      });
      await act(async () => {
        inFlight.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      });

      expect(result.current.saveStatus).toBe("saved");
      expect(result.current.hasPendingChanges).toBe(false);
      unmount();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    /**
     * "a" is in flight when switching tabs sends "ab" outside the drain loop. Back on the
     * tab, "abc" waits in the queue until "a" answers.
     */
    async function typeAcrossATabSwitch(result: { current: ReturnType<typeof useAutoSave> }) {
      act(() => {
        result.current.debouncedSave({ title: "a" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.debouncedSave({ title: "ab" });
      });
      setVisibility("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      setVisibility("visible");
      expect(sentBody(1)).toEqual({ title: "ab" });
      act(() => {
        result.current.debouncedSave({ title: "abc" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
    }

    it("doesn't put a failed flush's edit back over a newer one that was saved", async () => {
      const inFlight = deferredFetch();
      const flush = deferredFetch();
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );
      await typeAcrossATabSwitch(result);
      await act(async () => {
        inFlight.resolve(okResponse);
      });
      expect(sentBody(2)).toEqual({ title: "abc" });
      expect(result.current.saveStatus).toBe("saved");

      // The "ab" flush fails last, and so does its plain-fetch retry.
      mockFetch.mockRejectedValueOnce(new Error("offline"));
      await act(async () => {
        flush.reject(new Error("offline"));
      });

      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(result.current.hasPendingChanges).toBe(false);
      expect(result.current.saveStatus).toBe("saved");
      unmount();
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("doesn't put a failed flush's edit back over a newer one still in flight", async () => {
      const inFlight = deferredFetch();
      const flush = deferredFetch();
      const newest = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      await typeAcrossATabSwitch(result);
      await act(async () => {
        inFlight.resolve(okResponse);
      });
      expect(sentBody(2)).toEqual({ title: "abc" });

      // "ab" fails while "abc" is in flight, then "abc" fails too (each with its retry).
      mockFetch.mockRejectedValueOnce(new Error("offline"));
      await act(async () => {
        flush.reject(new Error("offline"));
      });
      mockFetch.mockRejectedValueOnce(new Error("offline"));
      await act(async () => {
        newest.reject(new Error("offline"));
      });
      expect(mockFetch).toHaveBeenCalledTimes(5);

      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(sentBody(5)).toEqual({ title: "abc" });
    });

    it("puts back only the fields of a failed flush that no newer save replaced", async () => {
      const inFlight = deferredFetch();
      const flush = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "A" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.debouncedSave({ title: "B", content: ["typed"] });
      });
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(sentBody(1)).toEqual({ title: "B", content: ["typed"] });
      act(() => {
        result.current.debouncedSave({ title: "C" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      await act(async () => {
        inFlight.resolve(okResponse);
      });
      expect(sentBody(2)).toEqual({ title: "C" });

      mockFetch.mockRejectedValueOnce(new Error("offline"));
      await act(async () => {
        flush.reject(new Error("offline"));
      });

      // The content is still unsaved; the title "B" would overwrite the saved "C".
      expect(result.current.saveStatus).toBe("error");
      expect(result.current.hasPendingChanges).toBe(true);
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(sentBody(4)).toEqual({ content: ["typed"] });
    });

    it("leaves edits discarded while in flight out of a later flush", async () => {
      const inFlight = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ content: ["discarded"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.cancelPendingSave();
      });
      act(() => {
        result.current.debouncedSave({ title: "After the reload" });
      });
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });

      expect(sentBody(1)).toEqual({ title: "After the reload" });
      await act(async () => {
        inFlight.resolve(okResponse);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("lets a failed flush go when its edits are discarded while its response is read", async () => {
      const inFlight = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ content: ["local"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      let sendBody: (body: unknown) => void = () => {};
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () =>
          new Promise((resolve) => {
            sendBody = resolve;
          }),
      });
      act(() => {
        result.current.debouncedSave({ title: "Local" });
      });
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
      });

      act(() => {
        result.current.cancelPendingSave();
      });
      await act(async () => {
        sendBody({});
      });
      await act(async () => {
        inFlight.resolve(okResponse);
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.current.hasPendingChanges).toBe(false);
      expect(sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("requeues a page-hide flush that fails while the note is still open", async () => {
      const inFlight = deferredFetch();
      failNextSend();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "First" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.debouncedSave({ title: "Second" });
      });
      setVisibility("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(result.current.hasPendingChanges).toBe(true);
      expect(result.current.saveStatus).toBe("error");

      // The drain loop picks the requeued edit up once the save in flight answers.
      await act(async () => {
        inFlight.resolve(okResponse);
      });
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(sentBody(3)).toEqual({ title: "Second" });
      expect(result.current.hasPendingChanges).toBe(false);
    });
  });

  describe("failed saves", () => {
    async function saveAndFlush(
      result: { current: ReturnType<typeof useAutoSave> },
      data: Record<string, unknown>,
    ) {
      act(() => {
        result.current.debouncedSave(data);
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
    }

    it("restores a payload whose fetch threw, and the next debounced save retries it", async () => {
      failNextSend();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "Typed offline" });
      expect(result.current.saveStatus).toBe("error");
      expect(result.current.hasPendingChanges).toBe(true);

      await saveAndFlush(result, { content: ["more"] });
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(sentBody(2)).toEqual({ title: "Typed offline", content: ["more"] });
      expect(result.current.saveStatus).toBe("saved");
      expect(result.current.hasPendingChanges).toBe(false);
    });

    it("restores a payload the server refused with a non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "Server hiccup" });
      expect(result.current.saveStatus).toBe("error");

      await saveAndFlush(result, { content: [] });
      expect(sentBody(1)).toEqual({ title: "Server hiccup", content: [] });
    });

    it("lets newer edits win over the restored payload", async () => {
      failNextSend();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "Old", content: ["kept"] });
      await saveAndFlush(result, { title: "New" });

      expect(sentBody(2)).toEqual({ title: "New", content: ["kept"] });
    });

    it("lets edits typed while the failed save was in flight win too", async () => {
      const inFlight = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "Old", content: ["kept"] });
      await saveAndFlush(result, { title: "Typed meanwhile" });
      mockFetch.mockRejectedValueOnce(new Error("offline"));
      await act(async () => {
        inFlight.reject(new Error("offline"));
      });

      // Past the plain-fetch retry of the refused keepalive send, the drain loop stops
      // after a failure rather than sending the queued edit straight away.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.current.hasPendingChanges).toBe(true);

      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(sentBody(2)).toEqual({ title: "Typed meanwhile", content: ["kept"] });
    });

    it("doesn't retry a failed save in a loop", async () => {
      mockFetch.mockRejectedValue(new Error("offline"));
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "T" });
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      // The keepalive send and its one plain-fetch retry, then nothing until the next edit.
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("flushes a restored payload on unmount", async () => {
      failNextSend();
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );

      await saveAndFlush(result, { title: "Retry me" });
      unmount();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(sentBody(2)).toEqual({ title: "Retry me" });
      expect(fetchInit(2).keepalive).toBe(true);
    });

    it("reports a thrown error to Sentry once per failure streak, without the payload", async () => {
      const error = new Error("offline");
      failNextSend(error);
      failNextSend(error);
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "Private text" });
      await saveAndFlush(result, { title: "More private text" });

      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      expect(sentry.captureException).toHaveBeenCalledWith(error, {
        extra: { where: "autosave", noteId: "note-1" },
      });
      expect(JSON.stringify(sentry.captureException.mock.calls)).not.toContain("private");

      // A success ends the streak; the next failure is reported again.
      await saveAndFlush(result, { title: "Online" });
      failNextSend(error);
      await saveAndFlush(result, { title: "Offline again" });
      expect(sentry.captureException).toHaveBeenCalledTimes(2);
    });

    it("reports a non-OK response to Sentry with its status", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "T" });

      expect(sentry.captureMessage).toHaveBeenCalledWith("Note autosave failed with HTTP 503", {
        level: "error",
        extra: { where: "autosave", noteId: "note-1", status: 503 },
      });
    });

    it("doesn't report a content-quota refusal", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: () =>
          Promise.resolve({
            error: "Note content quota exceeded",
            code: "content_quota_exceeded",
            usedBytes: 26214400,
            quotaBytes: 26214400,
          }),
      });
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { content: ["big"] });

      expect(result.current.saveStatus).toBe("error");
      expect(sentry.captureException).not.toHaveBeenCalled();
      expect(sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("reports a save that fails after unmount, and doesn't requeue it", async () => {
      const inFlight = deferredFetch();
      const error = new Error("offline");
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );

      await saveAndFlush(result, { title: "T" });
      unmount();
      mockFetch.mockRejectedValueOnce(error);
      await act(async () => {
        inFlight.reject(error);
      });

      // The keepalive send and its plain-fetch retry; no hook is left to send it again.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(sentry.captureException).toHaveBeenCalledWith(error, {
        extra: { where: "autosave", noteId: "note-1" },
      });
    });
  });

  describe("logout flush registry", () => {
    it("registers a flusher that sends pending edits and waits for the save", async () => {
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 1000 }));
      act(() => {
        result.current.debouncedSave({ title: "Before logout" });
      });

      await act(async () => {
        await flushPendingSaves();
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sentBody(0)).toEqual({ title: "Before logout" });
      expect(result.current.saveStatus).toBe("saved");
    });

    it("waits for a save already in flight", async () => {
      const inFlight = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "In flight" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      let done = false;
      const flushed = flushPendingSaves({ timeoutMs: 60000 }).then(() => {
        done = true;
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(done).toBe(false);

      await act(async () => {
        inFlight.resolve(okResponse);
        await flushed;
      });
      expect(done).toBe(true);
    });

    it("waits for a save an earlier page hide sent outside the drain loop", async () => {
      const inFlight = deferredFetch();
      const flush = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ title: "First" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.debouncedSave({ title: "Second" });
      });
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      // The drain loop is done, and nothing is queued, but the flush is still in flight.
      await act(async () => {
        inFlight.resolve(okResponse);
      });

      let done = false;
      const flushed = flushPendingSaves({ timeoutMs: 60000 }).then(() => {
        done = true;
      });
      await act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(done).toBe(false);

      await act(async () => {
        flush.resolve(okResponse);
        await flushed;
      });
      expect(done).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("unregisters on unmount", async () => {
      const { unmount } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 1000 }));
      unmount();

      await act(async () => {
        await flushPendingSaves();
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
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

    it("doesn't bring a cancelled edit back when the save in flight fails", async () => {
      const inFlight = deferredFetch();
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );
      act(() => {
        result.current.debouncedSave({ content: ["local"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.cancelPendingSave();
      });
      await act(async () => {
        inFlight.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      });

      expect(result.current.hasPendingChanges).toBe(false);
      // The badge doesn't stay on "Saving" for a request whose edit was discarded.
      expect(result.current.saveStatus).toBe("idle");
      unmount();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("shows edits typed after the cancel as unsaved when the cancelled save fails", async () => {
      const inFlight = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      act(() => {
        result.current.debouncedSave({ content: ["local"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.cancelPendingSave();
      });
      // A new edit, debounced while the discarded save is still in flight, waits in the queue.
      act(() => {
        result.current.debouncedSave({ title: "After the reload" });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      await act(async () => {
        inFlight.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      });

      expect(result.current.saveStatus).toBe("error");
      expect(result.current.hasPendingChanges).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // The next edit sends it, without the discarded one.
      act(() => {
        result.current.debouncedSave({ content: ["new"] });
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(sentBody(1)).toEqual({ title: "After the reload", content: ["new"] });
      expect(result.current.saveStatus).toBe("saved");
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

  // The editor panel forwards this to the note list, so the row shows what the
  // server stored rather than whatever the list was fetched with.
  describe("lastSavedTitle", () => {
    async function saveAndRespondWith(
      data: Record<string, unknown>,
      response: Record<string, unknown>,
    ) {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(response) });
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));
      expect(result.current.lastSavedTitle).toBeNull();

      act(() => {
        result.current.debouncedSave(data);
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      return result;
    }

    it("exposes the title the server stored with the latest save", async () => {
      const result = await saveAndRespondWith(
        { title: "Groceries" },
        { updated_at: "2026-10-17T12:00:00.000+00:00", title: "Groceries" },
      );

      expect(result.current.lastSavedTitle).toBe("Groceries");
      expect(result.current.lastSavedAt).toBe("2026-10-17T12:00:00.000+00:00");
    });

    it("takes it from the response, so a content-only save reports the stored title", async () => {
      const result = await saveAndRespondWith(
        { content: [] },
        { updated_at: "2026-10-17T12:00:00.000+00:00", title: "Title on the server" },
      );

      expect(result.current.lastSavedTitle).toBe("Title on the server");
    });

    it("stays null when the response carries no title", async () => {
      const result = await saveAndRespondWith(
        { title: "Typed" },
        { updated_at: "2026-10-17T12:00:00.000+00:00" },
      );

      expect(result.current.lastSavedAt).toBe("2026-10-17T12:00:00.000+00:00");
      expect(result.current.lastSavedTitle).toBeNull();
    });
  });
});
