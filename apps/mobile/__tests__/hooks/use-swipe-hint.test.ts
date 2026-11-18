import { renderHook, act, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";

import { useSwipeHint } from "@/hooks/use-swipe-hint";
import type { SwipeHintList } from "@/lib/swipe-hint-store";

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

/** Stored flags by key; a missing key reads as null. */
function storeFlags(flags: Record<string, string>) {
  mockSecureStore.getItemAsync.mockImplementation(async (key: string) => flags[key] ?? null);
}

function renderSwipeHint(list: SwipeHintList, firstRowId = "row-1") {
  return renderHook(({ id }: { id: string | undefined }) => useSwipeHint(list, id), {
    initialProps: { id: firstRowId },
  });
}

describe("useSwipeHint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeFlags({});
    mockSecureStore.setItemAsync.mockResolvedValue(undefined);
  });

  it("starts hidden, so a returning user never sees it flash", async () => {
    const { result } = renderSwipeHint("notes");

    expect(result.current.visible).toBe(false);
    expect(result.current.peekRowId).toBeNull();
    await act(async () => {});
  });

  it("shows the hint and peeks the first row on a list the user hasn't dismissed", async () => {
    const { result } = renderSwipeHint("notes");

    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(result.current.peekRowId).toBe("row-1");
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_seen_notes");
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_peeked_notes");
  });

  it("stays hidden once the hint was dismissed on this device", async () => {
    storeFlags({ drafto_swipe_hint_seen_trash: "1" });
    const { result } = renderSwipeHint("trash");

    await act(async () => {});

    expect(result.current.visible).toBe(false);
    expect(result.current.peekRowId).toBeNull();
  });

  it("keeps the hint but never slides again once the peek has played on this device", async () => {
    storeFlags({ drafto_swipe_hint_peeked_notes: "1" });
    const { result } = renderSwipeHint("notes");

    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(result.current.peekRowId).toBeNull();
  });

  it("stays hidden, with a warning, when a flag can't be read", async () => {
    mockSecureStore.getItemAsync.mockRejectedValue(new Error("keychain locked"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderSwipeHint("notebooks");

    await waitFor(() => expect(warn).toHaveBeenCalled());

    expect(result.current.visible).toBe(false);
    expect(warn.mock.calls[0][0]).toContain("notebooks swipe hint");
    warn.mockRestore();
  });

  it("hides the hint and saves the flag once, however often it is dismissed", async () => {
    const { result } = renderSwipeHint("notes");
    await waitFor(() => expect(result.current.visible).toBe(true));

    act(() => result.current.dismiss());
    act(() => result.current.dismiss());

    expect(result.current.visible).toBe(false);
    expect(result.current.peekRowId).toBeNull();
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
    const { result } = renderSwipeHint("notes");

    act(() => result.current.dismiss());
    await act(async () => finishRead(null));

    expect(result.current.visible).toBe(false);
  });

  it("warns when the flag can't be saved", async () => {
    mockSecureStore.setItemAsync.mockRejectedValue(new Error("disk full"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderSwipeHint("trash");
    await waitFor(() => expect(result.current.visible).toBe(true));

    act(() => result.current.dismiss());

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toContain("trash swipe hint");
    warn.mockRestore();
  });

  it("ends the peek for good, once, but keeps the hint", async () => {
    const { result } = renderSwipeHint("notes");
    await waitFor(() => expect(result.current.peekRowId).toBe("row-1"));

    act(() => result.current.endPeek());
    act(() => result.current.endPeek());

    expect(result.current.visible).toBe(true);
    expect(result.current.peekRowId).toBeNull();
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      "drafto_swipe_hint_peeked_notes",
      "1",
    );
  });

  it("warns when the peek flag can't be saved", async () => {
    mockSecureStore.setItemAsync.mockRejectedValue(new Error("disk full"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderSwipeHint("notebooks");
    await waitFor(() => expect(result.current.peekRowId).toBe("row-1"));

    act(() => result.current.endPeek());

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toContain("notebooks swipe peek");
    warn.mockRestore();
  });

  it("keeps the peek on the row that was first when it armed", async () => {
    const { result, rerender } = renderSwipeHint("notes");
    await waitFor(() => expect(result.current.peekRowId).toBe("row-1"));

    // A new row lands on top of the list.
    rerender({ id: "row-new" });

    expect(result.current.peekRowId).toBe("row-1");
  });

  it("arms the peek once the list has a first row", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useSwipeHint("trash", id),
      { initialProps: { id: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(result.current.peekRowId).toBeNull();

    rerender({ id: "row-1" });

    expect(result.current.peekRowId).toBe("row-1");
  });

  it("ignores a read that lands after unmount", async () => {
    let finishRead!: (value: string | null) => void;
    mockSecureStore.getItemAsync.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const { result, unmount } = renderSwipeHint("notes");

    unmount();
    await act(async () => finishRead(null));

    expect(result.current.visible).toBe(false);
  });
});
