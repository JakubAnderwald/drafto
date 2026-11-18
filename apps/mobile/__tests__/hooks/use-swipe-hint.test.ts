import { renderHook, act, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";

import { useSwipeHint } from "@/hooks/use-swipe-hint";

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe("useSwipeHint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSecureStore.getItemAsync.mockResolvedValue(null);
    mockSecureStore.setItemAsync.mockResolvedValue(undefined);
  });

  it("starts hidden, so a returning user never sees it flash", async () => {
    const { result } = renderHook(() => useSwipeHint("notes"));

    expect(result.current.visible).toBe(false);
    expect(result.current.peek).toBe(false);
    await act(async () => {});
  });

  it("shows the hint and the peek on a list the user hasn't dismissed", async () => {
    const { result } = renderHook(() => useSwipeHint("notes"));

    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(result.current.peek).toBe(true);
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_seen_notes");
  });

  it("stays hidden once the hint was dismissed on this device", async () => {
    mockSecureStore.getItemAsync.mockResolvedValue("1");
    const { result } = renderHook(() => useSwipeHint("trash"));

    await act(async () => {});

    expect(result.current.visible).toBe(false);
    expect(result.current.peek).toBe(false);
  });

  it("stays hidden, with a warning, when the flag can't be read", async () => {
    mockSecureStore.getItemAsync.mockRejectedValue(new Error("keychain locked"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useSwipeHint("notebooks"));

    await waitFor(() => expect(warn).toHaveBeenCalled());

    expect(result.current.visible).toBe(false);
    expect(warn.mock.calls[0][0]).toContain("notebooks swipe hint");
    warn.mockRestore();
  });

  it("hides the hint and saves the flag once, however often it is dismissed", async () => {
    const { result } = renderHook(() => useSwipeHint("notes"));
    await waitFor(() => expect(result.current.visible).toBe(true));

    act(() => result.current.dismiss());
    act(() => result.current.dismiss());

    expect(result.current.visible).toBe(false);
    expect(result.current.peek).toBe(false);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_seen_notes", "1");
  });

  it("doesn't bring the hint back when a dismissal beats the stored read", async () => {
    let finishRead!: (value: string | null) => void;
    mockSecureStore.getItemAsync.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const { result } = renderHook(() => useSwipeHint("notes"));

    act(() => result.current.dismiss());
    await act(async () => finishRead(null));

    expect(result.current.visible).toBe(false);
  });

  it("warns when the flag can't be saved", async () => {
    mockSecureStore.setItemAsync.mockRejectedValue(new Error("disk full"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useSwipeHint("trash"));
    await waitFor(() => expect(result.current.visible).toBe(true));

    act(() => result.current.dismiss());

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toContain("trash swipe hint");
    warn.mockRestore();
  });

  it("ends the peek but keeps the hint", async () => {
    const { result } = renderHook(() => useSwipeHint("notes"));
    await waitFor(() => expect(result.current.visible).toBe(true));

    act(() => result.current.endPeek());

    expect(result.current.visible).toBe(true);
    expect(result.current.peek).toBe(false);
  });

  it("ignores a read that lands after unmount", async () => {
    let finishRead!: (value: string | null) => void;
    mockSecureStore.getItemAsync.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const { result, unmount } = renderHook(() => useSwipeHint("notes"));

    unmount();
    await act(async () => finishRead(null));

    expect(result.current.visible).toBe(false);
  });
});
