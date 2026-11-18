import { Alert, type AlertButton } from "react-native";
import { renderHook, act, waitFor } from "@testing-library/react-native";
import { SIGN_OUT_SYNCED_MESSAGE, SIGN_OUT_UNKNOWN_MESSAGE } from "@drafto/shared";

import {
  PRE_SIGN_OUT_SYNC_TIMEOUT_MS,
  describeSignOut,
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
function alertButtons(alert: jest.SpyInstance, call = 0): AlertButton[] {
  return (alert.mock.calls[call][2] ?? []) as AlertButton[];
}

/** Answers every confirmation with its destructive confirm button. */
function confirmEveryAlert(): jest.SpyInstance {
  return jest
    .spyOn(Alert, "alert")
    .mockImplementation((_title, _message, buttons) => buttons?.[1]?.onPress?.());
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

  it("words the confirmation for synced, unsynced and unknown counts", () => {
    expect(describeSignOut(0)).toEqual({
      message: SIGN_OUT_SYNCED_MESSAGE,
      confirmLabel: "Sign out",
    });
    expect(describeSignOut(2)).toEqual({
      message: "2 changes haven't synced and will be lost.",
      confirmLabel: "Sign out anyway",
    });
    expect(describeSignOut(null)).toEqual({
      message: SIGN_OUT_UNKNOWN_MESSAGE,
      confirmLabel: "Sign out",
    });
  });

  it("asks before signing out even when everything is synced", async () => {
    // PrimeTestLab report 10668 (S-02): one tap on Sign Out wiped the device without asking.
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const { result } = renderHook(() => useSafeSignOut());

    act(() => {
      void result.current.signOut();
    });
    await waitFor(() => {
      expect(alert).toHaveBeenCalledTimes(1);
    });

    expect(alert).toHaveBeenCalledWith(
      "Sign out?",
      SIGN_OUT_SYNCED_MESSAGE,
      expect.any(Array),
      expect.objectContaining({ cancelable: true }),
    );
    const buttons = alertButtons(alert);
    expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Sign out"]);
    expect(buttons[0].style).toBe("cancel");
    expect(buttons[1].style).toBe("destructive");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(result.current.isSigningOut).toBe(true);

    await act(async () => {
      buttons[1].onPress?.();
    });

    // Nothing to push, so neither a last sync nor the provider's repeat flush.
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
    expect(result.current.isSigningOut).toBe(false);
  });

  it("keeps the session on Cancel when everything is synced", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const { result } = renderHook(() => useSafeSignOut());

    act(() => {
      void result.current.signOut();
    });
    await waitFor(() => {
      expect(alert).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      alertButtons(alert)[0].onPress?.();
    });

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(result.current.isSigningOut).toBe(false);
  });

  it("treats dismissing the synced confirmation as Cancel", async () => {
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

  it("ignores a second sign-out while the confirmation is open", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const { result } = renderHook(() => useSafeSignOut());

    act(() => {
      void result.current.signOut();
    });
    await waitFor(() => {
      expect(alert).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await result.current.signOut();
    });

    expect(alert).toHaveBeenCalledTimes(1);
    expect(mockCountUnsyncedChanges).toHaveBeenCalledTimes(1);

    await act(async () => {
      alertButtons(alert)[1].onPress?.();
    });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
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
    confirmEveryAlert();
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
    const alert = confirmEveryAlert();
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
    expect(alert).not.toHaveBeenCalled();

    await act(async () => {
      finishSync();
      await done;
    });

    expect(mockCountUnsyncedChanges).toHaveBeenCalledTimes(2);
    // The last sync pushed everything, so the one confirmation says so.
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toBe(SIGN_OUT_SYNCED_MESSAGE);
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
    expect(alertButtons(alert).map((button) => button.text)).toEqual(["Cancel", "Sign out anyway"]);
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

  it("treats dismissing the unsynced confirmation as Cancel", async () => {
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

  it("warns generically and signs out with the provider's flush when the count cannot be read", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockCountUnsyncedChanges.mockRejectedValue(new Error("SQLite busy"));
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const { result } = renderHook(() => useSafeSignOut());

    act(() => {
      void result.current.signOut();
    });
    await waitFor(() => {
      expect(alert).toHaveBeenCalledTimes(1);
    });

    expect(alert).toHaveBeenCalledWith(
      "Sign out?",
      SIGN_OUT_UNKNOWN_MESSAGE,
      expect.any(Array),
      expect.objectContaining({ cancelable: true }),
    );
    expect(alertButtons(alert).map((button) => button.text)).toEqual(["Cancel", "Sign out"]);
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();

    await act(async () => {
      alertButtons(alert)[1].onPress?.();
    });

    // A failed count must not trap the user in the account.
    expect(mockSignOut).toHaveBeenCalledWith();
  });

  it("keeps the session on Cancel when the count cannot be read", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockCountUnsyncedChanges.mockRejectedValue(new Error("SQLite busy"));
    jest
      .spyOn(Alert, "alert")
      .mockImplementation((_title, _message, buttons) => buttons?.[0]?.onPress?.());
    const { result } = renderHook(() => useSafeSignOut());

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(result.current.isSigningOut).toBe(false);
  });

  it("tells the user when sign-out itself fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const alert = confirmEveryAlert();
    mockSignOut.mockRejectedValue(new Error("storage locked"));
    const { result } = renderHook(() => useSafeSignOut());

    await act(async () => {
      await result.current.signOut();
    });

    expect(error).toHaveBeenCalledWith("Sign-out failed:", expect.any(Error));
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls[0][0]).toBe("Sign out?");
    expect(alert).toHaveBeenLastCalledWith(
      "Couldn't sign out",
      "Check your connection and try again.",
    );
    expect(result.current.isSigningOut).toBe(false);
  });
});
