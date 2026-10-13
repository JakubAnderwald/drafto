import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";
import type { KeyboardEventName } from "react-native";

// iOS sends "will" events as the keyboard starts to move, so layout can follow
// it; Android only sends "did" events.
const SHOW_EVENT: KeyboardEventName =
  Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
const HIDE_EVENT: KeyboardEventName =
  Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

/** Whether the software keyboard is on screen. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(() => Keyboard.isVisible());

  useEffect(() => {
    const show = Keyboard.addListener(SHOW_EVENT, () => setVisible(true));
    const hide = Keyboard.addListener(HIDE_EVENT, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return visible;
}
