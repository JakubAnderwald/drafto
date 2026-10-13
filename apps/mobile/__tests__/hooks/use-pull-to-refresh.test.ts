import { renderHook, act } from "@testing-library/react-native";

import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";

describe("usePullToRefresh", () => {
  it("is not refreshing until the user pulls", () => {
    const { result } = renderHook(() => usePullToRefresh(jest.fn().mockResolvedValue(undefined)));

    expect(result.current.refreshing).toBe(false);
  });

  it("stays refreshing until the refresh resolves", async () => {
    let finish!: () => void;
    const refresh = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => usePullToRefresh(refresh));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.onRefresh();
    });
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      finish();
      await pending;
    });
    expect(result.current.refreshing).toBe(false);
  });

  it("stops the spinner and logs when the refresh fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const refresh = jest.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => usePullToRefresh(refresh));

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(result.current.refreshing).toBe(false);
    expect(warn).toHaveBeenCalledWith("Pull to refresh failed:", expect.any(Error));
    warn.mockRestore();
  });
});
