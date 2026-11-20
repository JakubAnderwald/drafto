import React from "react";
import { StyleSheet } from "react-native";
import * as SecureStore from "expo-secure-store";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { SwipeHint, SWIPE_HINT_TEXT } from "@/components/swipe-hint";
import { semanticDark, semanticLight } from "@/theme/tokens";

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe("SwipeHint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSecureStore.getItemAsync.mockResolvedValue(null);
  });

  it("shows its text with the ids the E2E flows look for", () => {
    const { getByTestId, getByText } = render(
      <SwipeHint text={SWIPE_HINT_TEXT.notes} onDismiss={jest.fn()} />,
    );

    expect(getByTestId("swipe-hint")).toBeTruthy();
    expect(getByTestId("swipe-hint-dismiss")).toBeTruthy();
    expect(getByText(SWIPE_HINT_TEXT.notes)).toBeTruthy();
  });

  it("dismisses from its close button, which screen readers can name", () => {
    const onDismiss = jest.fn();
    const { getByRole } = render(<SwipeHint text={SWIPE_HINT_TEXT.trash} onDismiss={onDismiss} />);

    fireEvent.press(getByRole("button", { name: "Dismiss hint" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("uses the muted surface token in light mode", () => {
    const { getByTestId } = render(<SwipeHint text="tip" onDismiss={jest.fn()} />);

    expect(StyleSheet.flatten(getByTestId("swipe-hint").props.style).backgroundColor).toBe(
      semanticLight.bgMuted,
    );
  });

  it("follows the dark theme", async () => {
    mockSecureStore.getItemAsync.mockResolvedValue("dark");
    const { getByTestId } = render(<SwipeHint text="tip" onDismiss={jest.fn()} />);

    await waitFor(() =>
      expect(StyleSheet.flatten(getByTestId("swipe-hint").props.style).backgroundColor).toBe(
        semanticDark.bgMuted,
      ),
    );
  });

  it("explains each list's own gestures", () => {
    expect(SWIPE_HINT_TEXT.notes).toMatch(/Swipe left on a note/);
    expect(SWIPE_HINT_TEXT.notebooks).toMatch(/Swipe left on a notebook/);
    expect(SWIPE_HINT_TEXT.trash).toMatch(/Swipe right on a note to restore it/);
    expect(SWIPE_HINT_TEXT.trash).toMatch(/tap a note/);
  });
});
