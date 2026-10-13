import { useCallback, useState } from "react";
import { Platform, useWindowDimensions, type LayoutChangeEvent } from "react-native";

/**
 * The `keyboardVerticalOffset` for a KeyboardAvoidingView that reaches the
 * bottom of the window.
 *
 * KeyboardAvoidingView works out how much of it the keyboard covers from its
 * own frame, which is relative to its parent, while the keyboard's position is
 * in window coordinates; the offset has to be the view's distance from the top
 * of the window. On a pushed screen that is the header height, but a screen in
 * an iOS sheet starts lower. Measuring the position doesn't work: under Fabric,
 * measureInWindow reads React's layout, which doesn't know where the sheet sits.
 * The view's height does reflect it, and both a pushed screen and a sheet
 * reach the bottom of the window, so the distance is the window height minus
 * the view's height.
 *
 * Android has no sheets, so it keeps `fallback` (the header height), as does
 * iOS until the first layout.
 */
export function useKeyboardVerticalOffset(fallback: number) {
  const { height: windowHeight } = useWindowDimensions();
  const [viewHeight, setViewHeight] = useState<number | null>(null);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setViewHeight(event.nativeEvent.layout.height);
  }, []);

  const offset =
    Platform.OS === "ios" && viewHeight !== null
      ? Math.max(windowHeight - viewHeight, 0)
      : fallback;

  return { offset, onLayout };
}
