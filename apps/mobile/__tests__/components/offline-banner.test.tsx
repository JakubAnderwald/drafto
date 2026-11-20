import React from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { render, fireEvent } from "../helpers/test-utils";
import { OfflineBanner } from "@/components/offline-banner";
import { colors, spacing } from "@/theme/tokens";

const mockStatusBar = jest.fn();
jest.mock("expo-status-bar", () => ({
  StatusBar: (props: { style: string }) => {
    mockStatusBar(props);
    return null;
  },
}));

function bannerStyle(getByTestId: (id: string) => { props: { style?: StyleProp<ViewStyle> } }) {
  return StyleSheet.flatten(getByTestId("offline-banner").props.style);
}

describe("OfflineBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('says "You are offline" on red when offline', () => {
    const { getByTestId, getByText } = render(<OfflineBanner variant="offline" />);

    expect(getByText("You are offline")).toBeTruthy();
    expect(bannerStyle(getByTestId).backgroundColor).toBe(colors.error);
  });

  it('says "Back online — syncing..." on green once reconnected', () => {
    const { getByTestId, getByText } = render(<OfflineBanner variant="reconnected" />);

    expect(getByText("Back online — syncing...")).toBeTruthy();
    expect(bannerStyle(getByTestId).backgroundColor).toBe(colors.success);
  });

  it("is part of the layout, not an overlay that could cover the header's Back button", () => {
    const { getByTestId } = render(<OfflineBanner variant="offline" />);

    const style = bannerStyle(getByTestId);
    expect(style.position).toBeUndefined();
    expect(style.zIndex).toBeUndefined();
    expect(style.top).toBeUndefined();
    expect(style.transform).toBeUndefined();
  });

  it("is announced as an alert", () => {
    const { getByTestId } = render(<OfflineBanner variant="offline" />);

    expect(getByTestId("offline-banner").props.accessibilityRole).toBe("alert");
    expect(getByTestId("offline-banner").props.accessibilityLiveRegion).toBe("polite");
  });

  it("below a header, pads only by its own spacing and leaves the status bar alone", () => {
    const { getByTestId } = render(<OfflineBanner variant="offline" />);

    expect(bannerStyle(getByTestId).paddingTop).toBe(spacing.xs);
    expect(mockStatusBar).not.toHaveBeenCalled();
  });

  it("at the top of a headerless screen, fills the status-bar area but leaves its style to SystemBars", () => {
    const { getByTestId } = render(<OfflineBanner variant="offline" topInset={47} />);

    expect(bannerStyle(getByTestId).paddingTop).toBe(47 + spacing.xs);
    // A StatusBar of its own would stay in effect under a pushed screen with a header.
    expect(mockStatusBar).not.toHaveBeenCalled();
  });

  it("reports its layout, so the screen can offset its keyboard by it", () => {
    const onLayout = jest.fn();
    const { getByTestId } = render(<OfflineBanner variant="offline" onLayout={onLayout} />);

    const event = { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 28 } } };
    fireEvent(getByTestId("offline-banner"), "layout", event);

    expect(onLayout).toHaveBeenCalledWith(event);
  });
});
