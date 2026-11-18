import { renderHook, act } from "@testing-library/react-native";

import { useNetworkStatus } from "@/hooks/use-network-status";
import { RECONNECTED_HOLD_MS, useOfflineBannerState } from "@/hooks/use-offline-banner-state";

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

  it("shows nothing for an app that starts online", () => {
    setConnected(true);

    const { result } = renderHook(() => useOfflineBannerState());

    expect(result.current).toBeNull();
  });

  it("shows the offline banner while there is no connection", () => {
    setConnected(false);

    const { result } = renderHook(() => useOfflineBannerState());

    expect(result.current).toBe("offline");
  });

  it("goes offline, then 'reconnected', then hides after the hold", () => {
    setConnected(true);
    const { result, rerender } = renderHook(() => useOfflineBannerState());
    expect(result.current).toBeNull();

    setConnected(false);
    rerender({});
    expect(result.current).toBe("offline");

    setConnected(true);
    rerender({});
    expect(result.current).toBe("reconnected");

    act(() => {
      jest.advanceTimersByTime(RECONNECTED_HOLD_MS - 1);
    });
    expect(result.current).toBe("reconnected");

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull();
  });

  it("goes straight back to 'offline' when the connection drops during the hold", () => {
    setConnected(false);
    const { result, rerender } = renderHook(() => useOfflineBannerState());

    setConnected(true);
    rerender({});
    expect(result.current).toBe("reconnected");

    setConnected(false);
    rerender({});
    expect(result.current).toBe("offline");

    // The cancelled hold timer must not hide the banner while still offline.
    act(() => {
      jest.advanceTimersByTime(RECONNECTED_HOLD_MS * 2);
    });
    expect(result.current).toBe("offline");

    setConnected(true);
    rerender({});
    expect(result.current).toBe("reconnected");
  });

  it("clears the hold timer on unmount", () => {
    setConnected(false);
    const { rerender, unmount } = renderHook(() => useOfflineBannerState());
    setConnected(true);
    rerender({});
    expect(jest.getTimerCount()).toBe(1);

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });
});
