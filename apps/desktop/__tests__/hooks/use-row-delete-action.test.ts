import { act, renderHook } from "@testing-library/react-native";
import type { AccessibilityActionEvent } from "react-native";

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
    const { result } = renderHook(() => useRowDeleteAction({ label: "Delete note", onDelete }));

    result.current.onKeyDown(keyEvent("a"));
    result.current.onKeyDown(keyEvent("Enter"));
    expect(onDelete).not.toHaveBeenCalled();

    result.current.onKeyDown(keyEvent("Backspace"));
    result.current.onKeyDown(keyEvent("Delete", { metaKey: true }));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("claims only bare and ⌘ delete natively, and keeps Pressable's Space and Enter", () => {
    const { result } = renderHook(() =>
      useRowDeleteAction({ label: "Delete note", onDelete: jest.fn() }),
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
    const { result } = renderHook(() => useRowDeleteAction({ label: "Delete note", onDelete }));

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
    const { result } = renderHook(() => useRowDeleteAction({ label: "Delete note", onDelete }));

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
      useRowDeleteAction({ label: "Delete notebook", onDelete, enabled: false }),
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
        useRowDeleteAction({ label: "Delete note", onDelete }),
      { initialProps: { onDelete: first } },
    );

    rerender({ onDelete: second });
    result.current.onKeyDown(keyEvent("Backspace"));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
