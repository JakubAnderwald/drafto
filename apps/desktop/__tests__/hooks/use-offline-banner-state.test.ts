import { renderHook, act } from "@testing-library/react-native";
import { RECONNECTED_HOLD_MS } from "@drafto/shared";

import { useNetworkStatus } from "@/hooks/use-network-status";
import { useOfflineBannerState } from "@/hooks/use-offline-banner-state";

// The state machine itself is tested in packages/shared (offline-banner.test.ts).
// These tests cover only the wiring: this app's network status and the hold timer.
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: jest.fn(),
}));

const mockUseNetworkStatus = jest.mocked(useNetworkStatus);

function setConnected(isConnected: boolean) {
  mockUseNetworkStatus.mockReturnValue({ isConnected, isInternetReachable: isConnected });
}

describe("useOfflineBannerState", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts from the network status", () => {
    setConnected(false);
    expect(renderHook(() => useOfflineBannerState()).result.current).toBe("offline");

    setConnected(true);
    expect(renderHook(() => useOfflineBannerState()).result.current).toBeNull();
  });

  it("follows the network and hides 'reconnected' once the hold has run", () => {
    setConnected(false);
    const { result, rerender } = renderHook(() => useOfflineBannerState());

    setConnected(true);
    rerender({});
    expect(result.current).toBe("reconnected");

    act(() => {
      jest.advanceTimersByTime(RECONNECTED_HOLD_MS);
    });
    expect(result.current).toBeNull();
  });

  it("cancels the hold timer when the connection drops again, and on unmount", () => {
    setConnected(false);
    const { rerender, unmount } = renderHook(() => useOfflineBannerState());
    setConnected(true);
    rerender({});
    expect(jest.getTimerCount()).toBe(1);

    setConnected(false);
    rerender({});
    expect(jest.getTimerCount()).toBe(0);

    setConnected(true);
    rerender({});
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
