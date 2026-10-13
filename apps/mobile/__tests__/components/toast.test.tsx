import React from "react";
import { StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { getDefaultHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { render, act } from "../helpers/test-utils";
import {
  ToastProvider,
  useToast,
  AUTO_DISMISS_MS,
  MAX_VISIBLE_TOASTS,
  SLIDE_DISTANCE,
} from "@/components/toast";
import { spacing } from "@/theme/tokens";

type ShowToast = ReturnType<typeof useToast>["showToast"];

/** Where an iPhone 12's header ends: the 47 pt inset plus a 44 pt bar. */
const HEADER_BOTTOM = 47 + 44;

let showToast!: ShowToast;

function CaptureToast() {
  showToast = useToast().showToast;
  return null;
}

function renderToasts() {
  return render(
    <ToastProvider>
      <CaptureToast />
    </ToastProvider>,
  );
}

function show(text: string) {
  act(() => showToast(text));
}

/** Runs the dismiss timer plus the 250 ms slide-out animation. */
function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe("ToastProvider", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(useSafeAreaInsets).mockReturnValue({ top: 47, bottom: 34, left: 0, right: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("sits at the top, below the header, not over the add button at the bottom", () => {
    const { getByTestId } = renderToasts();

    const style = StyleSheet.flatten(getByTestId("toast-container").props.style);
    expect(getDefaultHeaderHeight).toHaveBeenCalledWith(
      expect.objectContaining({ width: 390, height: 844 }),
      false,
      47,
    );
    expect(style.top).toBe(HEADER_BOTTOM + spacing.sm);
    expect(style.bottom).toBeUndefined();
  });

  it("clears the header's back button, which used to sit under the toast", () => {
    const { getByTestId } = renderToasts();

    const style = StyleSheet.flatten(getByTestId("toast-container").props.style);
    // A 44 pt bar below the 47 pt inset ends at 91 pt; the toast starts lower.
    expect(style.top).toBeGreaterThan(47 + 44);
  });

  it("drops in from no higher than the header, so it never covers the header's buttons", () => {
    const { getByText } = renderToasts();

    show("Saved");

    // Walk up from the text to the animated toast and read its first frame.
    let node = getByText("Saved").parent;
    while (node && !StyleSheet.flatten(node.props.style)?.transform) node = node.parent;
    const transform = StyleSheet.flatten(node?.props.style).transform as Array<{
      translateY?: number;
    }>;
    const startY = transform.find((t) => t.translateY !== undefined)?.translateY;

    expect(startY).toBe(SLIDE_DISTANCE);
    expect(startY).toBeLessThan(0);
    // Container top (header + gap) plus the start offset stays at or below the header.
    expect(HEADER_BOTTOM + spacing.sm + (startY ?? 0)).toBeGreaterThanOrEqual(HEADER_BOTTOM);
  });

  it("dismisses a toast after AUTO_DISMISS_MS", () => {
    const { queryByText } = renderToasts();

    show("Saved");
    expect(queryByText("Saved")).toBeTruthy();

    advance(AUTO_DISMISS_MS + 500);
    expect(queryByText("Saved")).toBeNull();
  });

  it("does not restart a toast's timer when another toast arrives", () => {
    const { queryByText } = renderToasts();

    show("First");
    advance(AUTO_DISMISS_MS - 1000);
    // A new toast re-renders the provider; this used to restart every timer.
    show("Second");
    advance(1500);

    expect(queryByText("First")).toBeNull();
    expect(queryByText("Second")).toBeTruthy();
  });

  it("shows identical text once, with one haptic", () => {
    const { getAllByText } = renderToasts();

    show("A note was updated from another device");
    show("A note was updated from another device");

    expect(getAllByText("A note was updated from another device")).toHaveLength(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  });

  it("shows the same text again once the first toast has gone", () => {
    const { getAllByText } = renderToasts();

    show("Saved");
    advance(AUTO_DISMISS_MS + 500);
    show("Saved");

    expect(getAllByText("Saved")).toHaveLength(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(2);
  });

  it(`shows at most ${MAX_VISIBLE_TOASTS} toasts, dropping the oldest`, () => {
    const { queryByText } = renderToasts();

    show("One");
    show("Two");
    show("Three");

    expect(queryByText("One")).toBeNull();
    expect(queryByText("Two")).toBeTruthy();
    expect(queryByText("Three")).toBeTruthy();
  });

  it("throws when used outside the provider", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<CaptureToast />)).toThrow("useToast must be used within a ToastProvider");
    error.mockRestore();
  });
});
