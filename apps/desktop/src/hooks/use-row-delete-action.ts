import { useCallback, useMemo, useRef } from "react";
import type { AccessibilityActionEvent, AccessibilityActionInfo } from "react-native";

/**
 * A key react-native-macos matches in `keyDownEvents`. Fabric reads an absent modifier as
 * "don't care" (Paper as "not held"), so each entry here spells every modifier out.
 */
interface HandledKey {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** The fields of a react-native-macos `onKeyDown` event this hook reads. */
export interface RowKeyDownEvent {
  nativeEvent: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  };
}

/**
 * Props for a list row's Pressable. `keyDownEvents` and `onKeyDown` are react-native-macos
 * props the react-native types don't declare, so the row takes them by spreading this object.
 */
export interface RowDeleteActionProps {
  keyDownEvents: HandledKey[] | undefined;
  onKeyDown: (event: RowKeyDownEvent) => void;
  accessibilityActions: AccessibilityActionInfo[];
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
}

// Delete (⌫) and Forward Delete (⌦), bare or with ⌘ as in Finder's "Move to Trash".
const DELETE_KEYS = ["Backspace", "Delete"];
const NO_MODIFIERS = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
// `keyDownEvents` replaces Pressable's own default of Space and Enter, the keys that press a
// focused row, so the list keeps them as Pressable declares them. A listed key is handled
// here and not passed on natively.
const ROW_KEY_EVENTS: HandledKey[] = [
  { key: " " },
  { key: "Enter" },
  ...DELETE_KEYS.flatMap((key) => [
    { key, ...NO_MODIFIERS },
    { key, ...NO_MODIFIERS, metaKey: true },
  ]),
];

/** True for ⌫ / ⌦ with no modifier, or with ⌘ alone. */
export function isDeleteKey({ nativeEvent }: RowKeyDownEvent): boolean {
  if (!DELETE_KEYS.includes(nativeEvent.key)) return false;
  return !nativeEvent.ctrlKey && !nativeEvent.altKey && !nativeEvent.shiftKey;
}

interface UseRowDeleteActionOptions {
  /** What the delete is called in VoiceOver's Actions menu: "Delete note". */
  label: string;
  /** The row's delete. While a returned promise is pending, further requests are ignored. */
  onDelete: () => void | Promise<void>;
  /** False while the row holds a text field, whose key presses bubble up to the row. */
  enabled?: boolean;
}

/**
 * Makes a row's delete reachable without a mouse: the Delete key on the focused row, and a
 * named action VoiceOver lists in the row's Actions menu (an NSAccessibilityCustomAction).
 * The row's hover-revealed × button stays as it is for mouse users.
 */
export function useRowDeleteAction({
  label,
  onDelete,
  enabled = true,
}: UseRowDeleteActionOptions): RowDeleteActionProps {
  // A held ⌫ auto-repeats; one delete at a time, so a notebook's confirm doesn't stack.
  const pending = useRef(false);

  const runDelete = useCallback(() => {
    if (!enabled || pending.current) return;
    const result = onDelete();
    if (!(result instanceof Promise)) return;
    pending.current = true;
    result.finally(() => {
      pending.current = false;
    });
  }, [enabled, onDelete]);

  const onKeyDown = useCallback(
    (event: RowKeyDownEvent) => {
      if (isDeleteKey(event)) runDelete();
    },
    [runDelete],
  );

  // Fabric names the custom action after `name` alone (Paper uses `label`), so the action's
  // name is the text VoiceOver reads.
  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === label) runDelete();
    },
    [label, runDelete],
  );

  return useMemo(
    () => ({
      // Undefined leaves Pressable's default in place.
      keyDownEvents: enabled ? ROW_KEY_EVENTS : undefined,
      onKeyDown,
      accessibilityActions: enabled ? [{ name: label, label }] : [],
      onAccessibilityAction,
    }),
    [enabled, label, onKeyDown, onAccessibilityAction],
  );
}
