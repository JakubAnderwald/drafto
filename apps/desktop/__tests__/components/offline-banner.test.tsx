import React from "react";
import { StyleSheet } from "react-native";

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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders nothing when connected and never was offline", () => {
    setConnected(true);

    const { toJSON } = render(<OfflineBanner />);
    expect(toJSON()).toBeNull();
  });

  it('shows "You are offline" when disconnected', () => {
    setConnected(false);

    render(<OfflineBanner />);
    expect(screen.getByText("You are offline")).toBeTruthy();
    expect(screen.getByTestId("offline-banner").props.accessibilityRole).toBe("alert");
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
