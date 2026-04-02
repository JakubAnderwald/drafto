import { renderHook, act, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";

import { useNetworkStatus } from "@/hooks/use-network-status";

describe("useNetworkStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("starts with optimistic defaults (connected: true)", () => {
    const { result } = renderHook(() => useNetworkStatus());

    expect(result.current.isConnected).toBe(true);
    expect(result.current.isInternetReachable).toBeNull();
  });

  it("fetches initial network state on mount", async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    });

    const { result } = renderHook(() => useNetworkStatus());

    await waitFor(() => {
      expect(result.current.isConnected).toBe(false);
    });
  });

  it("subscribes to network state changes", () => {
    renderHook(() => useNetworkStatus());

    expect(NetInfo.addEventListener).toHaveBeenCalled();
  });

  it("updates state when network changes", async () => {
    let listener:
      | ((state: { isConnected: boolean; isInternetReachable: boolean }) => void)
      | undefined;
    (NetInfo.addEventListener as jest.Mock).mockImplementation((callback) => {
      listener = callback;
      return jest.fn();
    });

    const { result } = renderHook(() => useNetworkStatus());

    act(() => {
      listener?.({ isConnected: false, isInternetReachable: false });
    });

    expect(result.current.isConnected).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    const mockUnsubscribe = jest.fn();
    (NetInfo.addEventListener as jest.Mock).mockReturnValue(mockUnsubscribe);

    const { unmount } = renderHook(() => useNetworkStatus());
    unmount();

    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it("handles null isConnected as false", async () => {
    let listener:
      | ((state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void)
      | undefined;
    (NetInfo.addEventListener as jest.Mock).mockImplementation((callback) => {
      listener = callback;
      return jest.fn();
    });

    const { result } = renderHook(() => useNetworkStatus());

    act(() => {
      listener?.({ isConnected: null, isInternetReachable: null });
    });

    expect(result.current.isConnected).toBe(false);
  });
});
