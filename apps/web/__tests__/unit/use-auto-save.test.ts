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
      mockFetch.mockResolvedValueOnce(quotaRefusal).mockRejectedValueOnce(new Error("offline"));
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

    it("reports a failed unmount flush to Sentry", async () => {
      const error = new Error("offline");
      mockFetch.mockRejectedValueOnce(error);
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

    it("removes its listeners on unmount", () => {
      const removeWindow = vi.spyOn(window, "removeEventListener");
      const removeDocument = vi.spyOn(document, "removeEventListener");
      const { unmount } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 1000 }));
      unmount();

      expect(removeWindow).toHaveBeenCalledWith("pagehide", expect.any(Function));
      expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(mockFetch).not.toHaveBeenCalled();
      removeWindow.mockRestore();
      removeDocument.mockRestore();
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

    it("requeues a page-hide flush that fails while the note is still open", async () => {
      const inFlight = deferredFetch();
      mockFetch.mockRejectedValueOnce(new Error("offline"));
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
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(sentBody(2)).toEqual({ title: "Second" });
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
      mockFetch.mockRejectedValueOnce(new Error("offline"));
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "Typed offline" });
      expect(result.current.saveStatus).toBe("error");
      expect(result.current.hasPendingChanges).toBe(true);

      await saveAndFlush(result, { content: ["more"] });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(sentBody(1)).toEqual({ title: "Typed offline", content: ["more"] });
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
      mockFetch.mockRejectedValueOnce(new Error("offline"));
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "Old", content: ["kept"] });
      await saveAndFlush(result, { title: "New" });

      expect(sentBody(1)).toEqual({ title: "New", content: ["kept"] });
    });

    it("lets edits typed while the failed save was in flight win too", async () => {
      const inFlight = deferredFetch();
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "Old", content: ["kept"] });
      await saveAndFlush(result, { title: "Typed meanwhile" });
      await act(async () => {
        inFlight.reject(new Error("offline"));
      });

      // The drain loop stops after a failure rather than retrying straight away.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.current.hasPendingChanges).toBe(true);

      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(sentBody(1)).toEqual({ title: "Typed meanwhile", content: ["kept"] });
    });

    it("doesn't retry a failed save in a loop", async () => {
      mockFetch.mockRejectedValue(new Error("offline"));
      const { result } = renderHook(() => useAutoSave({ noteId: "note-1", debounceMs: 100 }));

      await saveAndFlush(result, { title: "T" });
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("flushes a restored payload on unmount", async () => {
      mockFetch.mockRejectedValueOnce(new Error("offline"));
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );

      await saveAndFlush(result, { title: "Retry me" });
      unmount();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(sentBody(1)).toEqual({ title: "Retry me" });
      expect(fetchInit(1).keepalive).toBe(true);
    });

    it("reports a thrown error to Sentry once per failure streak, without the payload", async () => {
      const error = new Error("offline");
      mockFetch.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
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
      mockFetch.mockRejectedValueOnce(error);
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

    it("reports a save that fails after unmount, and doesn't retry it", async () => {
      const inFlight = deferredFetch();
      const error = new Error("offline");
      const { result, unmount } = renderHook(() =>
        useAutoSave({ noteId: "note-1", debounceMs: 100 }),
      );

      await saveAndFlush(result, { title: "T" });
      unmount();
      await act(async () => {
        inFlight.reject(error);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
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
