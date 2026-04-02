import { renderHook, act, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";

import { useNetworkStatus } from "@/hooks/use-network-status";

const mockFetch = NetInfo.fetch as jest.MockedFunction<typeof NetInfo.fetch>;
const mockAddEventListener = NetInfo.addEventListener as jest.MockedFunction<
  typeof NetInfo.addEventListener
>;

describe("useNetworkStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    } as never);
    mockAddEventListener.mockReturnValue(jest.fn());
  });

  it("defaults to connected with null reachability", () => {
    const { result } = renderHook(() => useNetworkStatus());

    expect(result.current.isConnected).toBe(true);
    expect(result.current.isInternetReachable).toBeNull();
  });

  it("updates when NetInfo.fetch resolves", async () => {
    mockFetch.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    } as never);

    const { result } = renderHook(() => useNetworkStatus());

    await waitFor(() => {
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isInternetReachable).toBe(false);
    });
  });

  it("subscribes to addEventListener and handles state changes", async () => {
    let listener: ((state: unknown) => void) | undefined;
    mockAddEventListener.mockImplementation((cb) => {
      listener = cb as (state: unknown) => void;
      return jest.fn();
    });

    const { result } = renderHook(() => useNetworkStatus());

    expect(mockAddEventListener).toHaveBeenCalledTimes(1);

    act(() => {
      listener?.({ isConnected: false, isInternetReachable: false });
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.isInternetReachable).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    const mockUnsubscribe = jest.fn();
    mockAddEventListener.mockReturnValue(mockUnsubscribe);

    const { unmount } = renderHook(() => useNetworkStatus());

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("handles null isConnected as false", async () => {
    mockFetch.mockResolvedValue({
      isConnected: null,
      isInternetReachable: null,
    } as never);

    const { result } = renderHook(() => useNetworkStatus());

    await waitFor(() => {
      expect(result.current.isConnected).toBe(false);
    });
  });
});
