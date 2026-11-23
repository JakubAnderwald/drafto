import React from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";

import { useNetworkStatus } from "@/hooks/use-network-status";

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: jest.fn(),
}));

const mockUseNetworkStatus = useNetworkStatus as jest.Mock;

// Import render after mocks are set up
import { render, screen, act } from "../helpers/test-utils";
import { OfflineBanner } from "@/components/offline-banner";
import { RECONNECTED_HOLD_MS } from "@drafto/shared";

function setConnected(isConnected: boolean) {
  mockUseNetworkStatus.mockReturnValue({ isConnected, isInternetReachable: isConnected });
}

describe("OfflineBanner", () => {
  let announce: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    announce.mockRestore();
  });

  it("renders nothing when connected and never was offline", () => {
    setConnected(true);

    const { toJSON } = render(<OfflineBanner />);
    expect(toJSON()).toBeNull();
    expect(announce).not.toHaveBeenCalled();
  });

  it('shows "You are offline" when disconnected', () => {
    setConnected(false);

    render(<OfflineBanner />);
    expect(screen.getByText("You are offline")).toBeTruthy();
  });

  // #872: react-native-macos exposes neither a <Text> nor a non-accessible View
  // to VoiceOver, and maps role "alert" to AXUnknown. The strip itself must be
  // the element: accessible, labelled, role "text" (AXStaticText), and its
  // testID becomes the AXIdentifier the in-test harness looks up.
  it("is one labelled accessibility element while offline", () => {
    setConnected(false);

    render(<OfflineBanner />);

    const banner = screen.getByTestId("offline-banner");
    expect(banner.props.accessible).toBe(true);
    expect(banner.props.accessibilityRole).toBe("text");
    expect(banner.props.accessibilityLabel).toBe("You are offline");
    expect(screen.getByLabelText("You are offline")).toBe(banner);
  });

  it("announces each message to VoiceOver once", () => {
    jest.useFakeTimers();
    try {
      setConnected(false);
      const { rerender } = render(<OfflineBanner />);
      rerender(<OfflineBanner />);
      expect(announce.mock.calls).toEqual([["You are offline"]]);

      setConnected(true);
      rerender(<OfflineBanner />);
      expect(screen.getByTestId("offline-banner").props.accessibilityLabel).toBe(
        "Back online — syncing...",
      );
      expect(announce.mock.calls).toEqual([["You are offline"], ["Back online — syncing..."]]);

      act(() => {
        jest.advanceTimersByTime(RECONNECTED_HOLD_MS);
      });
      expect(screen.queryByTestId("offline-banner")).toBeNull();
      expect(announce).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("is part of the layout, not an overlay over the panes", () => {
    setConnected(false);

    render(<OfflineBanner />);

    const style = StyleSheet.flatten(screen.getByTestId("offline-banner").props.style);
    expect(style.position).toBeUndefined();
    expect(style.zIndex).toBeUndefined();
    expect(style.top).toBeUndefined();
    expect(style.transform).toBeUndefined();
  });

  it('shows "Back online — syncing..." after reconnection, then hides', () => {
    jest.useFakeTimers();
    try {
      setConnected(false);
      const { rerender } = render(<OfflineBanner />);
      expect(screen.getByText("You are offline")).toBeTruthy();

      setConnected(true);
      rerender(<OfflineBanner />);
      expect(screen.getByText("Back online — syncing...")).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(RECONNECTED_HOLD_MS);
      });
      expect(screen.queryByTestId("offline-banner")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
