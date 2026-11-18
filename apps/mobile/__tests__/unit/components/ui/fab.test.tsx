import React from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { render, fireEvent, renderHook } from "../../../helpers/test-utils";
import {
  Fab,
  FAB_MARGIN,
  FAB_SIZE,
  LIST_RESTING_PADDING,
  computeFabLayout,
  useFabLayout,
} from "@/components/ui/fab";
import { spacing } from "@/theme/tokens";

const mockedInsets = jest.mocked(useSafeAreaInsets);

/** The tab bar's height as the bottom tab navigator provides it. */
const TAB_BAR_HEIGHT = 49;

function setBottomInset(bottom: number) {
  mockedInsets.mockReturnValue({ top: 24, bottom, left: 0, right: 0 });
}

/** Renders like a screen inside the bottom tab navigator. */
function InsideTabs({ children }: { children: React.ReactNode }) {
  return (
    <BottomTabBarHeightContext.Provider value={TAB_BAR_HEIGHT}>
      {children}
    </BottomTabBarHeightContext.Provider>
  );
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
    expect(LIST_RESTING_PADDING).toBe(spacing.sm);
  });

  it("sits above the system bar outside the tab navigator (a stack screen)", () => {
    setBottomInset(48);

    const { getByTestId } = render(
      <Fab testID="fab" accessibilityLabel="New note" onPress={jest.fn()} />,
    );

    expect(fabStyle(getByTestId).bottom).toBe(spacing.xl + 48);
  });

  it("ignores the system inset inside the tab navigator, whose tab bar takes it", () => {
    setBottomInset(48);

    const { getByTestId } = render(
      <InsideTabs>
        <Fab testID="fab" accessibilityLabel="New notebook" onPress={jest.fn()} />
      </InsideTabs>,
    );

    expect(fabStyle(getByTestId).bottom).toBe(spacing.xl);
  });

  it("uses the plain margin when the device has no bottom inset", () => {
    const { getByTestId } = render(
      <Fab testID="fab" accessibilityLabel="New note" onPress={jest.fn()} />,
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
    const { UNSAFE_root } = render(<Fab accessibilityLabel="New note" onPress={jest.fn()} />);
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

describe("computeFabLayout", () => {
  it("adds the system inset only outside the tab navigator", () => {
    expect(computeFabLayout(34, false).fabBottom).toBe(FAB_MARGIN + 34);
    expect(computeFabLayout(34, true).fabBottom).toBe(FAB_MARGIN);
  });

  it("pads a list past the FAB, and past the system bar outside tabs", () => {
    expect(computeFabLayout(34, false).listPaddingBottom).toBe(FAB_SIZE + FAB_MARGIN * 2 + 34);
    expect(computeFabLayout(34, true).listPaddingBottom).toBe(FAB_SIZE + FAB_MARGIN * 2);
  });

  it("falls back to the resting padding while the FAB is hidden", () => {
    expect(computeFabLayout(34, false, false).listPaddingBottom).toBe(LIST_RESTING_PADDING + 34);
    expect(computeFabLayout(34, true, false).listPaddingBottom).toBe(LIST_RESTING_PADDING);
  });
});

describe("useFabLayout", () => {
  beforeEach(() => {
    setBottomInset(34);
  });

  it("clears the FAB and the system inset outside the tab navigator", () => {
    const { result } = renderHook(() => useFabLayout());

    expect(result.current).toEqual({
      fabBottom: FAB_MARGIN + 34,
      listPaddingBottom: FAB_SIZE + FAB_MARGIN * 2 + 34,
    });
  });

  it("clears only the FAB inside the tab navigator", () => {
    const { result } = renderHook(() => useFabLayout(), { wrapper: InsideTabs });

    expect(result.current).toEqual({
      fabBottom: FAB_MARGIN,
      listPaddingBottom: FAB_SIZE + FAB_MARGIN * 2,
    });
  });

  it("gives the list its resting padding while the FAB is hidden", () => {
    const { result, rerender } = renderHook(
      ({ fabVisible }: { fabVisible: boolean }) => useFabLayout(fabVisible),
      { initialProps: { fabVisible: false } },
    );
    expect(result.current.listPaddingBottom).toBe(LIST_RESTING_PADDING + 34);

    rerender({ fabVisible: true });
    expect(result.current.listPaddingBottom).toBe(FAB_SIZE + FAB_MARGIN * 2 + 34);
  });
});
