import { act } from "@testing-library/react-native";

import type { FocusNavigation } from "@/hooks/use-navigation-focus";

/** A stand-in for a screen's react-navigation `navigation`, whose focus a test can change. */
export interface FakeNavigation extends FocusNavigation {
  /** Focuses or blurs the screen and sends the matching event, as a navigator would. */
  setFocused: (focused: boolean) => void;
}

export function fakeNavigation(initiallyFocused = true): FakeNavigation {
  let focused = initiallyFocused;
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  return {
    isFocused: () => focused,
    addListener: (type, callback) => {
      listeners[type].add(callback);
      return () => {
        listeners[type].delete(callback);
      };
    },
    setFocused: (next) => {
      focused = next;
      act(() => listeners[next ? "focus" : "blur"].forEach((callback) => callback()));
    },
  };
}
