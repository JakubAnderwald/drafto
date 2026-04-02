import React from "react";

import { render } from "../helpers/test-utils";
import { OfflineBanner } from "../../src/components/offline-banner";

let mockIsConnected = true;

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({
    isConnected: mockIsConnected,
    isInternetReachable: mockIsConnected,
  }),
}));

describe("OfflineBanner", () => {
  beforeEach(() => {
    mockIsConnected = true;
  });

  it("renders nothing when online and never been offline", () => {
    const { queryByText } = render(<OfflineBanner />);

    expect(queryByText("You are offline")).toBeNull();
    expect(queryByText(/Back online/)).toBeNull();
  });

  it("shows offline message when disconnected", () => {
    mockIsConnected = false;

    const { getByText } = render(<OfflineBanner />);

    expect(getByText("You are offline")).toBeTruthy();
  });
});
