import { StrictMode, createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { mockRpc, mockCaptureMessage } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: mockRpc }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: mockCaptureMessage,
}));

type HookModule = typeof import("@/hooks/use-activity-ping");

const DAY_1 = "2026-11-13";
const DAY_2 = "2026-11-14";

/** A fresh copy of the hook module: its in-memory guards start empty, like after a reload. */
async function loadHook(): Promise<HookModule> {
  vi.resetModules();
  return import("@/hooks/use-activity-ping");
}

function setNow(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

function rpcArgs(day: string) {
  return ["record_activity", { p_days: [day], p_client: "web" }];
}

/** Lets the hook's fire-and-forget promise chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("useActivityPing", () => {
  let mod: HookModule;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setNow(`${DAY_1}T10:00:00.000Z`);
    window.sessionStorage.clear();
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ error: null });
    mockCaptureMessage.mockReset();
    mod = await loadHook();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("records today once and marks the session only after the server accepted it", async () => {
    let resolveRpc: (value: { error: null }) => void = () => {};
    mockRpc.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRpc = resolve;
      }),
    );

    renderHook(() => mod.useActivityPing("user-1"));

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(...rpcArgs(DAY_1));
    // Still in flight: nothing is marked yet.
    expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBeNull();

    resolveRpc({ error: null });
    await waitFor(() =>
      expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${DAY_1}`),
    );
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("uses the UTC day, not the local one", async () => {
    // 23:30 in New York on the 13th is already the 14th in UTC.
    vi.setSystemTime(new Date("2026-11-13T23:30:00-05:00"));

    renderHook(() => mod.useActivityPing("user-1"));

    expect(mockRpc).toHaveBeenCalledWith(...rpcArgs(DAY_2));
  });

  it("sends nothing on a second mount the same day, in the same page or after a reload", async () => {
    const first = renderHook(() => mod.useActivityPing("user-1"));
    await waitFor(() =>
      expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${DAY_1}`),
    );
    first.unmount();

    renderHook(() => mod.useActivityPing("user-1"));
    await flush();

    // A reload keeps sessionStorage but starts the module afresh.
    const reloaded = await loadHook();
    renderHook(() => reloaded.useActivityPing("user-1"));
    await flush();

    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("records again on the next UTC day", async () => {
    const first = renderHook(() => mod.useActivityPing("user-1"));
    await waitFor(() =>
      expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${DAY_1}`),
    );
    first.unmount();

    setNow(`${DAY_2}T00:00:01.000Z`);
    renderHook(() => mod.useActivityPing("user-1"));

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenLastCalledWith(...rpcArgs(DAY_2));
    await waitFor(() =>
      expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${DAY_2}`),
    );
  });

  it("records again for another user in the same tab", async () => {
    const first = renderHook(() => mod.useActivityPing("user-1"));
    await waitFor(() =>
      expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${DAY_1}`),
    );
    first.unmount();

    renderHook(() => mod.useActivityPing("user-2"));

    expect(mockRpc).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-2:${DAY_1}`),
    );
  });

  it("re-checks when the user returns to a tab left open into the next UTC day", async () => {
    renderHook(() => mod.useActivityPing("user-1"));
    await waitFor(() =>
      expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${DAY_1}`),
    );

    // Same day: returning to the tab sends nothing.
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(mockRpc).toHaveBeenCalledTimes(1);

    setNow(`${DAY_2}T08:00:00.000Z`);
    window.dispatchEvent(new Event("focus"));
    // Both events fire when the user comes back; the second finds the day in flight.
    document.dispatchEvent(new Event("visibilitychange"));

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenLastCalledWith(...rpcArgs(DAY_2));
  });

  it("records the new UTC day at midnight while the tab stays in front", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    setNow(`${DAY_1}T23:59:00.000Z`);
    renderHook(() => mod.useActivityPing("user-1"));
    // waitFor polls with setTimeout, which this test fakes.
    await flush();
    expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${DAY_1}`);

    // No focus, visibility change or remount: only the clock moves.
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenLastCalledWith(...rpcArgs(DAY_2));
  });

  it("leaves a midnight rollover to the user's return when the tab is hidden", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    setNow(`${DAY_1}T23:59:00.000Z`);
    renderHook(() => mod.useActivityPing("user-1"));
    await flush();

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(mockRpc).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenLastCalledWith(...rpcArgs(DAY_2));
  });

  it("does not ping when the tab turns hidden", async () => {
    renderHook(() => mod.useActivityPing("user-1"));
    await flush();
    setNow(`${DAY_2}T08:00:00.000Z`);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    visibility.mockRestore();

    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    setNow(`${DAY_1}T23:59:00.000Z`);
    const { unmount } = renderHook(() => mod.useActivityPing("user-1"));
    await flush();
    unmount();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    window.dispatchEvent(new Event("focus"));

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a failed ping unmarked so the next mount retries it", async () => {
    mockRpc.mockResolvedValueOnce({ error: { message: "permission denied" } });

    const first = renderHook(() => mod.useActivityPing("user-1"));
    await waitFor(() => expect(mockCaptureMessage).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBeNull();
    first.unmount();

    renderHook(() => mod.useActivityPing("user-1"));

    expect(mockRpc).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${DAY_1}`),
    );
  });

  it("reports at most one Sentry warning per page session, however many pings fail", async () => {
    mockRpc.mockResolvedValueOnce({ error: { message: "permission denied" } });
    mockRpc.mockRejectedValueOnce(new Error("Failed to fetch"));
    mockRpc.mockResolvedValueOnce({ error: { message: "permission denied" } });

    for (let i = 0; i < 3; i += 1) {
      const { unmount } = renderHook(() => mod.useActivityPing("user-1"));
      await flush();
      unmount();
    }

    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Activity ping failed",
      expect.objectContaining({
        level: "warning",
        extra: { error: "permission denied" },
      }),
    );
    expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBeNull();
  });

  it("keeps working when sessionStorage can't be reached at all", async () => {
    // What browsers that block site data do: reading window.sessionStorage throws.
    const storage = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });

    const first = renderHook(() => mod.useActivityPing("user-1"));
    await flush();
    first.unmount();

    // Without storage, the page still remembers the day it recorded.
    renderHook(() => mod.useActivityPing("user-1"));
    await flush();

    expect(storage).toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("keeps working when sessionStorage refuses to store the marker", async () => {
    const setItem = vi
      .spyOn(Object.getPrototypeOf(window.sessionStorage) as Storage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      });

    const first = renderHook(() => mod.useActivityPing("user-1"));
    await waitFor(() => expect(setItem).toHaveBeenCalled());
    first.unmount();

    renderHook(() => mod.useActivityPing("user-1"));
    await flush();

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("reports a client that can't be created as a failure instead of throwing", async () => {
    const supabaseClient = await import("@/lib/supabase/client");
    vi.spyOn(supabaseClient, "createClient").mockImplementationOnce(() => {
      throw new Error("Invalid environment variables");
    });

    expect(() => renderHook(() => mod.useActivityPing("user-1"))).not.toThrow();
    await waitFor(() => expect(mockCaptureMessage).toHaveBeenCalledTimes(1));

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Activity ping failed",
      expect.objectContaining({ extra: { error: "Invalid environment variables" } }),
    );
    expect(mockRpc).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(mod.ACTIVITY_DAY_STORAGE_KEY)).toBeNull();
  });

  it("makes one call under StrictMode's double effect", async () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children);

    renderHook(() => mod.useActivityPing("user-1"), { wrapper });
    await flush();

    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("returns before the ping has finished", () => {
    mockRpc.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => mod.useActivityPing("user-1"));

    expect(result.current).toBeUndefined();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
