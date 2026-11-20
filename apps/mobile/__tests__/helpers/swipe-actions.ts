import type { AccessibilityActionInfo } from "react-native";
import { fireEvent, type RenderResult } from "@testing-library/react-native";

/** A rendered element, as the queries return it. */
type ReactTestInstance = ReturnType<RenderResult["getByText"]>;

/** The nearest element at or above `element` that carries a SwipeableRow's accessibility actions. */
export function swipeActionsHost(element: ReactTestInstance): ReactTestInstance {
  let node: ReactTestInstance | null = element;
  while (node && !node.props.accessibilityActions) node = node.parent;
  if (!node) throw new Error("No element with accessibilityActions above this one");
  return node;
}

/** The labels a screen reader offers for the row holding `element`. */
export function swipeActionLabels(element: ReactTestInstance): string[] {
  const actions = swipeActionsHost(element).props.accessibilityActions as AccessibilityActionInfo[];
  return actions.map((action) => action.label ?? action.name);
}

/** Runs the row's swipe action labelled `label`, the way TalkBack or VoiceOver would. */
export function triggerSwipeAction(element: ReactTestInstance, label: string): void {
  const host = swipeActionsHost(element);
  const actions = host.props.accessibilityActions as AccessibilityActionInfo[];
  const action = actions.find((candidate) => candidate.label === label);
  if (!action) {
    throw new Error(
      `No "${label}" action; the row offers ${JSON.stringify(swipeActionLabels(element))}`,
    );
  }
  fireEvent(host, "accessibilityAction", { nativeEvent: { actionName: action.name } });
}
