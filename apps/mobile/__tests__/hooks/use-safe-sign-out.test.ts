import { Alert, type AlertButton } from "react-native";
import { renderHook, act, waitFor } from "@testing-library/react-native";

import {
  PRE_SIGN_OUT_SYNC_TIMEOUT_MS,
  describeUnsyncedLoss,
  useSafeSignOut,
} from "@/hooks/use-safe-sign-out";
import { registerPendingSave } from "@/lib/pending-saves";

const mockSignOut = jest.fn();
jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ signOut: mockSignOut }),
}));

const mockSync = jest.fn();
jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({ database: {}, sync: mockSync }),
}));

const mockCountUnsyncedChanges = jest.fn();
jest.mock("@/lib/data/unsynced-changes", () => ({
  countUnsyncedChanges: (...args: unknown[]) => mockCountUnsyncedChanges(...args),
}));

/** The buttons of the confirmation the hook raised. */
function alertButtons(alert: jest.SpyInstance): AlertButton[] {
  return (alert.mock.calls[0][2] ?? []) as AlertButton[];
}

describe("useSafeSignOut", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignOut.mockResolvedValue(undefined);
    mockSync.mockResolvedValue(undefined);
    mockCountUnsyncedChanges.mockResolvedValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("describes the loss in the singular and the plural", () => {
    expect(describeUnsyncedLoss(1)).toBe("1 change hasn't synced and will be lost.");
    expect(describeUnsyncedLoss(4)).toBe("4 changes haven't synced and will be lost.");
  });

  it("signs out without the provider's repeat flush once nothing is pending", async () => {
    const { result } = renderHook(() => useSafeSignOut());

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockSync).not.toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
    expect(result.current.isSigningOut).toBe(false);
  });

  it("writes a debounced editor save before it counts", async () => {
    // An edit inside the editor's save debounce is not in the database yet: without the flush
    // it would be neither counted nor synced, then wiped.
    const order: string[] = [];
    const unregister = registerPendingSave(async () => {
      await Promise.resolve();
      order.push("flushed");
    });
    mockCountUnsyncedChanges.mockImplementation(async () => {
      order.push("counted");
      return 0;
    });
    const { result } = renderHook(() => useSafeSignOut());

    await act(async () => {
      await result.current.signOut();
    });
    unregister();

    expect(order).toEqual(["flushed", "counted"]);
    expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
  });

  it("counts again only once the sync it awaited has finished", async () => {
    // The provider's sync() joins a sync already running (ADR-0048), so this one await also
    // covers a push that was in flight when the user pressed Sign Out.
    let finishSync: () => void = () => {};
    mockSync.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
    );
    mockCountUnsyncedChanges.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const { result } = renderHook(() => useSafeSignOut());

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.signOut();
    });
    await waitFor(() => {
      expect(mockSync).toHaveBeenCalledTimes(1);
    });
    expect(mockCountUnsyncedChanges).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();

    await act(async () => {
      finishSync();
      await done;
    });

    expect(mockCountUnsyncedChanges).toHaveBeenCalledTimes(2);
    expect(alert).not.toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
  });

  it("stops waiting for a sync that hangs and asks before discarding", async () => {
    jest.useFakeTimers();
    mockSync.mockReturnValue(new Promise(() => {}));
    mockCountUnsyncedChanges.mockResolvedValue(2);
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const { result } = renderHook(() => useSafeSignOut());

    act(() => {
      void result.current.signOut();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isSigningOut).toBe(true);
    expect(alert).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(PRE_SIGN_OUT_SYNC_TIMEOUT_MS);
    });

    expect(alert).toHaveBeenCalledWith(
      "Sign out?",
      "2 changes haven't synced and will be lost.",
      expect.any(Array),
      expect.objectContaining({ cancelable: true }),
    );
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("drops the unsynced changes without a second flush on Sign out anyway", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockSync.mockRejectedValue(new Error("offline"));
    mockCountUnsyncedChanges.mockResolvedValue(1);
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const { result } = renderHook(() => useSafeSignOut());

    act(() => {
      void result.current.signOut();
    });
    await waitFor(() => {
      expect(alert).toHaveBeenCalledTimes(1);
    });
    // The failed sync was treated as unfinished and the rows counted again.
    expect(mockCountUnsyncedChanges).toHaveBeenCalledTimes(2);

    await act(async () => {
      alertButtons(alert)[1].onPress?.();
    });

    expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
  });

  it("treats dismissing the confirmation as Cancel", async () => {
    mockCountUnsyncedChanges.mockResolvedValue(1);
    jest.spyOn(Alert, "alert").mockImplementation((_title, _message, _buttons, options) => {
      options?.onDismiss?.();
    });
    const { result } = renderHook(() => useSafeSignOut());

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(result.current.isSigningOut).toBe(false);
  });

  it("signs out as before, with the provider's flush, when the count cannot be read", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockCountUnsyncedChanges.mockRejectedValue(new Error("SQLite busy"));
    const { result } = renderHook(() => useSafeSignOut());

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockSignOut).toHaveBeenCalledWith();
  });

  it("tells the user when sign-out itself fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    mockSignOut.mockRejectedValue(new Error("storage locked"));
    const { result } = renderHook(() => useSafeSignOut());

    await act(async () => {
      await result.current.signOut();
    });

    expect(error).toHaveBeenCalledWith("Sign-out failed:", expect.any(Error));
    expect(alert).toHaveBeenCalledWith("Couldn't sign out", "Check your connection and try again.");
    expect(result.current.isSigningOut).toBe(false);
  });
});
