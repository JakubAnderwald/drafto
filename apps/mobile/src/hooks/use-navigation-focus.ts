import { useCallback, useSyncExternalStore } from "react";

/**
 * The part of a react-navigation `navigation` object that focus tracking reads.
 * Structural, so a navigator's `screenLayout` can pass its `navigation` prop.
 */
export interface FocusNavigation {
  isFocused: () => boolean;
  addListener: (type: "focus" | "blur", callback: () => void) => () => void;
}

/**
 * Whether the screen of `navigation` is focused, kept up to date.
 *
 * react-navigation's `useIsFocused` reads the navigation from context, which a
 * `screenLayout` is given as a prop instead. This reads the same thing from the
 * prop: `isFocused()` (which is false while a parent route is blurred too) and
 * the `focus` / `blur` events, which a navigator also sends its focused child
 * when its own route gains or loses focus.
 */
export function useNavigationFocus(navigation: FocusNavigation): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribeFocus = navigation.addListener("focus", onChange);
      const unsubscribeBlur = navigation.addListener("blur", onChange);
      return () => {
        unsubscribeFocus();
        unsubscribeBlur();
      };
    },
    [navigation],
  );
  return useSyncExternalStore(subscribe, navigation.isFocused, navigation.isFocused);
}
