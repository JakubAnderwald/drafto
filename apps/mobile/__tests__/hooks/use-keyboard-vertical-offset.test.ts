import { renderHook, act } from "@testing-library/react-native";
import { Dimensions, Platform, type LayoutChangeEvent } from "react-native";

import { useKeyboardVerticalOffset } from "@/hooks/use-keyboard-vertical-offset";

const HEADER_HEIGHT = 116;
/** The test environment's window height (useWindowDimensions reads the same). */
const WINDOW_HEIGHT = Dimensions.get("window").height;

function layoutWithHeight(height: number): LayoutChangeEvent {
  return { nativeEvent: { layout: { x: 0, y: 0, width: 402, height } } } as LayoutChangeEvent;
}

describe("useKeyboardVerticalOffset", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses the header height until the view has laid out", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { result } = renderHook(() => useKeyboardVerticalOffset(HEADER_HEIGHT));

    expect(result.current.offset).toBe(HEADER_HEIGHT);
  });

  it("on a pushed screen works out to the header height", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { result } = renderHook(() => useKeyboardVerticalOffset(HEADER_HEIGHT));

    act(() => result.current.onLayout(layoutWithHeight(WINDOW_HEIGHT - HEADER_HEIGHT)));

    expect(result.current.offset).toBe(HEADER_HEIGHT);
  });

  it("in an iOS sheet includes how far down the sheet starts", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { result } = renderHook(() => useKeyboardVerticalOffset(HEADER_HEIGHT));

    // On the iOS 27 simulator (874 pt window) the sheet's editor was 732 pt tall,
    // so it started 142 pt down: the sheet's offset plus its header.
    act(() => result.current.onLayout(layoutWithHeight(WINDOW_HEIGHT - 142)));

    expect(result.current.offset).toBe(142);
  });

  it("keeps the header height on Android, which has no sheets", () => {
    jest.replaceProperty(Platform, "OS", "android");
    const { result } = renderHook(() => useKeyboardVerticalOffset(HEADER_HEIGHT));

    act(() => result.current.onLayout(layoutWithHeight(732)));

    expect(result.current.offset).toBe(HEADER_HEIGHT);
  });
});
