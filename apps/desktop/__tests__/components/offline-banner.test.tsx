import React from "react";

import { useNetworkStatus } from "@/hooks/use-network-status";

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: jest.fn(),
}));

const mockUseNetworkStatus = useNetworkStatus as jest.Mock;

// Import render after mocks are set up
import { render, screen } from "../helpers/test-utils";
import { OfflineBanner } from "@/components/offline-banner";

describe("OfflineBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders nothing when connected and never was offline", () => {
    mockUseNetworkStatus.mockReturnValue({
      isConnected: true,
      isInternetReachable: true,
    });

    const { toJSON } = render(<OfflineBanner />);
    expect(toJSON()).toBeNull();
  });

  it('shows "You are offline" when disconnected', () => {
    mockUseNetworkStatus.mockReturnValue({
      isConnected: false,
      isInternetReachable: false,
    });

    render(<OfflineBanner />);
    expect(screen.getByText("You are offline")).toBeTruthy();
  });

  it('shows "Back online — syncing..." after reconnection', () => {
    // Start offline
    mockUseNetworkStatus.mockReturnValue({
      isConnected: false,
      isInternetReachable: false,
    });

    const { rerender } = render(<OfflineBanner />);
    expect(screen.getByText("You are offline")).toBeTruthy();

    // Go back online
    mockUseNetworkStatus.mockReturnValue({
      isConnected: true,
      isInternetReachable: true,
    });

    rerender(<OfflineBanner />);
    expect(screen.getByText("Back online — syncing...")).toBeTruthy();
  });
});
