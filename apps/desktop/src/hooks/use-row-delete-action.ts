import { useCallback, useMemo, useRef, type RefObject } from "react";
import type { AccessibilityActionEvent, AccessibilityActionInfo, View } from "react-native";

import { focusView } from "@/lib/focus-view";

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
 * Props for a list row's Pressable. `keyDownEvents`, `onKeyDown` and `enableFocusRing` are
 * react-native-macos props the react-native types don't declare, so the row takes them by
 * spreading this object.
 */
export interface RowDeleteActionProps {
  ref: RefObject<View | null>;
  onPress: () => void;
  enableFocusRing: boolean;
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
  /** The row's own press (select). The returned `onPress` runs it, then focuses the row. */
  onPress: () => void;
  /** The row's delete. While a returned promise is pending, further requests are ignored. */
  onDelete: () => void | Promise<void>;
  /**
   * Whether the row is the selected one. The Delete key acts only then: a row keeps keyboard
   * focus when the selection moves some other way (New note, search), and a ⌫ must never
   * trash a row the user no longer sees as selected. VoiceOver's action doesn't need it.
   */
  isSelected: boolean;
  /**
   * False while a rename field is open in the list: its key presses bubble up to the row, and
   * focusing a row would blur it and drop the typed name.
   */
  enabled?: boolean;
}

/**
 * Makes a row's delete reachable without the hover-only × button: the Delete key on the
 * focused row, and a named action VoiceOver lists in the row's Actions menu (an
 * NSAccessibilityCustomAction).
 *
 * react-native-macos never lets a click move keyboard focus (`needsPanelToBecomeKey`), and its
 * rows aren't in the Tab order, so pressing the row also focuses it, as a click on a note in
 * Apple Notes does. The focus ring stays off: the row's selected style already marks it.
 */
export function useRowDeleteAction({
  label,
  onPress,
  onDelete,
  isSelected,
  enabled = true,
}: UseRowDeleteActionOptions): RowDeleteActionProps {
  const ref = useRef<View>(null);
  // A held ⌫ auto-repeats. One delete at a time: a repeat that lands while a notebook's
  // guard is still counting its notes is dropped. (The guard's promise settles once its
  // alert is shown; the alert itself is modal and takes the keys from there.)
  const pending = useRef(false);
  const keysActive = enabled && isSelected;

  const runDelete = useCallback(() => {
    if (!enabled || pending.current) return;
    const result = onDelete();
    if (!(result instanceof Promise)) return;
    pending.current = true;
    result.finally(() => {
      pending.current = false;
    });
  }, [enabled, onDelete]);

  const handlePress = useCallback(() => {
    onPress();
    // While disabled the row holds a text field, which keeps the focus.
    if (enabled) focusView(ref.current);
  }, [enabled, onPress]);

  const onKeyDown = useCallback(
    (event: RowKeyDownEvent) => {
      if (keysActive && isDeleteKey(event)) runDelete();
    },
    [keysActive, runDelete],
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
      ref,
      onPress: handlePress,
      enableFocusRing: false,
      // Undefined leaves Pressable's default in place.
      keyDownEvents: keysActive ? ROW_KEY_EVENTS : undefined,
      onKeyDown,
      accessibilityActions: enabled ? [{ name: label, label }] : [],
      onAccessibilityAction,
    }),
    [enabled, keysActive, label, handlePress, onKeyDown, onAccessibilityAction],
  );
}
