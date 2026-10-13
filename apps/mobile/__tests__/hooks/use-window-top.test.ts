import { renderHook, act } from "@testing-library/react-native";
import type { View } from "react-native";

import { useWindowTop } from "@/hooks/use-window-top";

/** Gives the hook a view that reports `y` as its distance from the top of the window. */
function attachView(ref: React.RefObject<View | null>, y: number) {
  (ref as { current: unknown }).current = {
    measureInWindow: (callback: (x: number, y: number) => void) => callback(0, y),
  };
}

describe("useWindowTop", () => {
  it("is null until the view has been measured", () => {
    const { result } = renderHook(() => useWindowTop());

    expect(result.current.top).toBeNull();
  });

  it("reports how far the view starts from the top of the window after layout", () => {
    const { result } = renderHook(() => useWindowTop());

    // A note in an iOS sheet: the sheet starts below the status bar, then its header.
    attachView(result.current.ref, 113);
    act(() => result.current.onLayout());

    expect(result.current.top).toBe(113);
  });

  it("measures again on each layout, as a sheet can settle somewhere else", () => {
    const { result } = renderHook(() => useWindowTop());

    attachView(result.current.ref, 91);
    act(() => result.current.onLayout());
    attachView(result.current.ref, 113);
    act(() => result.current.onLayout());

    expect(result.current.top).toBe(113);
  });
});
