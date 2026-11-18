import React from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { render, fireEvent, renderHook } from "../../../helpers/test-utils";
import {
  Fab,
  FAB_MARGIN,
  FAB_SIZE,
  fabBottomOffset,
  useFabListPadding,
} from "../../../../src/components/ui/fab";
import { spacing } from "../../../../src/theme/tokens";

const mockedInsets = jest.mocked(useSafeAreaInsets);

function setBottomInset(bottom: number) {
  mockedInsets.mockReturnValue({ top: 24, bottom, left: 0, right: 0 });
}

function fabStyle(getByTestId: (id: string) => { props: { style?: StyleProp<ViewStyle> } }) {
  return StyleSheet.flatten(getByTestId("fab").props.style);
}

describe("Fab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setBottomInset(0);
  });

  it("keeps the documented size and margin", () => {
    expect(FAB_SIZE).toBe(56);
    expect(FAB_MARGIN).toBe(spacing.xl);
  });

  it("sits above the system bar when clearSystemBottomInset is set", () => {
    setBottomInset(48);

    const { getByTestId } = render(
      <Fab testID="fab" accessibilityLabel="New note" clearSystemBottomInset onPress={jest.fn()} />,
    );

    expect(fabStyle(getByTestId).bottom).toBe(spacing.xl + 48);
  });

  it("ignores the system inset without clearSystemBottomInset (the tab-bar case)", () => {
    setBottomInset(48);

    const { getByTestId } = render(
      <Fab testID="fab" accessibilityLabel="New notebook" onPress={jest.fn()} />,
    );

    expect(fabStyle(getByTestId).bottom).toBe(spacing.xl);
  });

  it("uses the plain margin when the device has no bottom inset", () => {
    const { getByTestId } = render(
      <Fab testID="fab" accessibilityLabel="New note" clearSystemBottomInset onPress={jest.fn()} />,
    );

    const style = fabStyle(getByTestId);
    expect(style.bottom).toBe(spacing.xl);
    expect(style.right).toBe(FAB_MARGIN);
    expect(style.width).toBe(FAB_SIZE);
    expect(style.height).toBe(FAB_SIZE);
    expect(style.position).toBe("absolute");
  });

  it("is an accessible button that calls onPress", () => {
    const onPress = jest.fn();
    const { getByRole } = render(
      <Fab testID="fab" accessibilityLabel="New note" onPress={onPress} />,
    );

    fireEvent.press(getByRole("button", { name: "New note" }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("renders the add icon by default and a custom icon when given", () => {
    const { getByText, rerender } = render(<Fab accessibilityLabel="Add" onPress={jest.fn()} />);
    expect(getByText("add")).toBeTruthy();

    rerender(<Fab accessibilityLabel="Edit" icon="create-outline" onPress={jest.fn()} />);
    expect(getByText("create-outline")).toBeTruthy();
  });

  it("darkens while pressed and keeps its offset", () => {
    setBottomInset(48);
    const { UNSAFE_root } = render(
      <Fab accessibilityLabel="New note" clearSystemBottomInset onPress={jest.fn()} />,
    );
    // Pressable's style callback, as the button receives it.
    const [pressable] = UNSAFE_root.findAll(
      (node: { props: { style?: unknown } }) => typeof node.props.style === "function",
    );
    const styleFor = pressable.props.style as (state: { pressed: boolean }) => StyleProp<ViewStyle>;

    const resting = StyleSheet.flatten(styleFor({ pressed: false }));
    const pressed = StyleSheet.flatten(styleFor({ pressed: true }));

    expect(pressed.backgroundColor).not.toBe(resting.backgroundColor);
    expect(pressed.bottom).toBe(spacing.xl + 48);
  });
});

describe("fabBottomOffset", () => {
  it("adds the inset only when asked to", () => {
    expect(fabBottomOffset(34, true)).toBe(FAB_MARGIN + 34);
    expect(fabBottomOffset(34, false)).toBe(FAB_MARGIN);
  });
});

describe("useFabListPadding", () => {
  beforeEach(() => {
    setBottomInset(34);
  });

  it("clears the FAB and the system inset on a screen without a tab bar", () => {
    const { result } = renderHook(() => useFabListPadding(true));

    expect(result.current).toBe(FAB_SIZE + FAB_MARGIN * 2 + 34);
  });

  it("clears only the FAB above a tab bar", () => {
    const { result } = renderHook(() => useFabListPadding(false));

    expect(result.current).toBe(FAB_SIZE + FAB_MARGIN * 2);
  });
});
