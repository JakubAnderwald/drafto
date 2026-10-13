import { useCallback, useRef, useState } from "react";
import type { View } from "react-native";

/**
 * How far a view starts from the top of the window, once it has laid out.
 *
 * A KeyboardAvoidingView works out how much of it the keyboard covers from its
 * own frame, which is relative to its parent, while the keyboard's position is
 * in window coordinates; `keyboardVerticalOffset` has to make up the
 * difference. That is the header height on a pushed screen, but a screen in an
 * iOS sheet starts lower, so the real distance has to be measured.
 *
 * `top` is null until the first measurement arrives.
 */
export function useWindowTop() {
  const ref = useRef<View>(null);
  const [top, setTop] = useState<number | null>(null);

  const onLayout = useCallback(() => {
    ref.current?.measureInWindow((_x, y) => setTop(y));
  }, []);

  return { ref, top, onLayout };
}
