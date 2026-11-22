import { act, renderHook } from "@testing-library/react-native";
import type { AccessibilityActionEvent, View } from "react-native";

import {
  isDeleteKey,
  useRowDeleteAction,
  type RowKeyDownEvent,
} from "@/hooks/use-row-delete-action";

const keyEvent = (key: string, modifiers: Partial<RowKeyDownEvent["nativeEvent"]> = {}) => ({
  nativeEvent: { key, ...modifiers },
});
const actionEvent = (actionName: string) =>
  ({ nativeEvent: { actionName } }) as AccessibilityActionEvent;

describe("isDeleteKey", () => {
  it.each(["Backspace", "Delete"])("accepts %s bare and with ⌘", (key) => {
    expect(isDeleteKey(keyEvent(key))).toBe(true);
    expect(isDeleteKey(keyEvent(key, { metaKey: true }))).toBe(true);
  });

  it.each(["ctrlKey", "altKey", "shiftKey"] as const)("rejects ⌫ with %s held", (modifier) => {
    expect(isDeleteKey(keyEvent("Backspace", { [modifier]: true }))).toBe(false);
  });

  it.each(["a", "Enter", " ", "Escape", "Tab"])("rejects %j", (key) => {
    expect(isDeleteKey(keyEvent(key))).toBe(false);
  });
});

describe("useRowDeleteAction", () => {
  it("deletes on the Delete key and ignores other keys", () => {
    const onDelete = jest.fn();
    const { result } = renderHook(() =>
      useRowDeleteAction({ label: "Delete note", onPress: jest.fn(), isSelected: true, onDelete }),
    );

    result.current.onKeyDown(keyEvent("a"));
    result.current.onKeyDown(keyEvent("Enter"));
    expect(onDelete).not.toHaveBeenCalled();

    result.current.onKeyDown(keyEvent("Backspace"));
    result.current.onKeyDown(keyEvent("Delete", { metaKey: true }));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("claims only bare and ⌘ delete natively, and keeps Pressable's Space and Enter", () => {
    const { result } = renderHook(() =>
      useRowDeleteAction({
        label: "Delete note",
        onPress: jest.fn(),
        isSelected: true,
        onDelete: jest.fn(),
      }),
    );

    // Fabric treats an absent modifier as "any", so every one is spelled out: ⌥⌫ and ⇧⌫
    // must still reach the native responder chain.
    const none = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(result.current.keyDownEvents).toEqual([
      { key: " " },
      { key: "Enter" },
      { key: "Backspace", ...none },
      { key: "Backspace", ...none, metaKey: true },
      { key: "Delete", ...none },
      { key: "Delete", ...none, metaKey: true },
    ]);
  });

  it("exposes one action named for VoiceOver and deletes when it runs", () => {
    const onDelete = jest.fn();
    const { result } = renderHook(() =>
      useRowDeleteAction({ label: "Delete note", onPress: jest.fn(), isSelected: true, onDelete }),
    );

    // Fabric builds the NSAccessibilityCustomAction from `name`, so `name` is the spoken text.
    expect(result.current.accessibilityActions).toEqual([
      { name: "Delete note", label: "Delete note" },
    ]);

    result.current.onAccessibilityAction(actionEvent("activate"));
    expect(onDelete).not.toHaveBeenCalled();

    result.current.onAccessibilityAction(actionEvent("Delete note"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("ignores repeats while an async delete is still running, then accepts the next", async () => {
    let finish: () => void = () => {};
    const onDelete = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useRowDeleteAction({ label: "Delete note", onPress: jest.fn(), isSelected: true, onDelete }),
    );

    // A held ⌫ auto-repeats.
    result.current.onKeyDown(keyEvent("Backspace"));
    result.current.onKeyDown(keyEvent("Backspace"));
    result.current.onAccessibilityAction(actionEvent("Delete note"));
    expect(onDelete).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    result.current.onKeyDown(keyEvent("Backspace"));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("does nothing while disabled and leaves Pressable's key default alone", () => {
    const onDelete = jest.fn();
    const { result } = renderHook(() =>
      useRowDeleteAction({
        label: "Delete notebook",
        onPress: jest.fn(),
        isSelected: true,
        onDelete,
        enabled: false,
      }),
    );

    expect(result.current.keyDownEvents).toBeUndefined();
    expect(result.current.accessibilityActions).toEqual([]);

    result.current.onKeyDown(keyEvent("Backspace"));
    result.current.onAccessibilityAction(actionEvent("Delete notebook"));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("calls the latest onDelete after a re-render", () => {
    const first = jest.fn();
    const second = jest.fn();
    const { result, rerender } = renderHook(
      ({ onDelete }: { onDelete: () => void }) =>
        useRowDeleteAction({
          label: "Delete note",
          onPress: jest.fn(),
          isSelected: true,
          onDelete,
        }),
      { initialProps: { onDelete: first } },
    );

    rerender({ onDelete: second });
    result.current.onKeyDown(keyEvent("Backspace"));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("focuses the row after its own press, with the focus ring off", () => {
    const calls: string[] = [];
    const onPress = jest.fn(() => calls.push("press"));
    const { result } = renderHook(() =>
      useRowDeleteAction({ label: "Delete note", onPress, onDelete: jest.fn(), isSelected: true }),
    );
    const focus = jest.fn(() => calls.push("focus"));
    result.current.ref.current = { focus } as unknown as View;

    result.current.onPress();

    // A click never moves key focus on react-native-macos, so the press does it.
    expect(calls).toEqual(["press", "focus"]);
    expect(result.current.enableFocusRing).toBe(false);
  });

  it("leaves focus alone while disabled (the rename field keeps it)", () => {
    const onPress = jest.fn();
    const { result } = renderHook(() =>
      useRowDeleteAction({
        label: "Delete notebook",
        onPress,
        onDelete: jest.fn(),
        isSelected: true,
        enabled: false,
      }),
    );
    const focus = jest.fn();
    result.current.ref.current = { focus } as unknown as View;

    result.current.onPress();

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  it("ignores ⌫ on a focused row that is no longer the selected one", () => {
    const onDelete = jest.fn();
    const { result } = renderHook(() =>
      useRowDeleteAction({ label: "Delete note", onPress: jest.fn(), onDelete, isSelected: false }),
    );

    // The row kept focus while the selection moved elsewhere (New note, search).
    result.current.onKeyDown(keyEvent("Backspace"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(result.current.keyDownEvents).toBeUndefined();

    // VoiceOver acts on the row it is on, selected or not.
    result.current.onAccessibilityAction(actionEvent("Delete note"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
