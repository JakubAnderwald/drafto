import { Keyboard, Platform } from "react-native";
import type { KeyboardEventListener, KeyboardEventName } from "react-native";
import { renderHook, act } from "@testing-library/react-native";

import { useKeyboardVisible } from "@/hooks/use-keyboard-visible";

describe("useKeyboardVisible", () => {
  const listeners = new Map<KeyboardEventName, KeyboardEventListener>();
  const removers: jest.Mock[] = [];

  beforeEach(() => {
    listeners.clear();
    removers.length = 0;
    jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
    jest.spyOn(Keyboard, "addListener").mockImplementation((event, listener) => {
      listeners.set(event, listener);
      const remove = jest.fn();
      removers.push(remove);
      return { remove } as unknown as ReturnType<typeof Keyboard.addListener>;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function emit(event: KeyboardEventName) {
    act(() => listeners.get(event)?.({} as Parameters<KeyboardEventListener>[0]));
  }

  it("tracks the keyboard showing and hiding", () => {
    const { result } = renderHook(() => useKeyboardVisible());
    expect(result.current).toBe(false);

    const [show, hide] =
      Platform.OS === "ios"
        ? (["keyboardWillShow", "keyboardWillHide"] as const)
        : (["keyboardDidShow", "keyboardDidHide"] as const);

    emit(show);
    expect(result.current).toBe(true);

    emit(hide);
    expect(result.current).toBe(false);
  });

  it("starts from the keyboard's current state", () => {
    jest.mocked(Keyboard.isVisible).mockReturnValue(true);

    const { result } = renderHook(() => useKeyboardVisible());

    expect(result.current).toBe(true);
  });

  it("removes its listeners on unmount", () => {
    const { unmount } = renderHook(() => useKeyboardVisible());

    unmount();

    expect(removers).toHaveLength(2);
    removers.forEach((remove) => expect(remove).toHaveBeenCalled());
  });
});
