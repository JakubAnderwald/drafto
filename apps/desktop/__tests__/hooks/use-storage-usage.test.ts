import { renderHook, act, waitFor } from "@testing-library/react-native";

import { fetchStorageUsage } from "@/lib/data";
import { useStorageUsage } from "@/hooks/use-storage-usage";

jest.mock("@/lib/data", () => ({
  fetchStorageUsage: jest.fn(),
}));

const mockFetchStorageUsage = fetchStorageUsage as jest.Mock;

describe("useStorageUsage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads the usage on mount", async () => {
    mockFetchStorageUsage.mockResolvedValue({ usedBytes: 10, quotaBytes: 100 });
    const { result } = renderHook(() => useStorageUsage());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.usage).toEqual({ usedBytes: 10, quotaBytes: 100 });
  });

  it("stops loading with no usage when it can't be read", async () => {
    mockFetchStorageUsage.mockResolvedValue(null);
    const { result } = renderHook(() => useStorageUsage());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.usage).toBeNull();
  });

  it("refreshes, and keeps the last reading when a refresh can't read it", async () => {
    mockFetchStorageUsage.mockResolvedValueOnce({ usedBytes: 10, quotaBytes: 100 });
    const { result } = renderHook(() => useStorageUsage());
    await waitFor(() => expect(result.current.usage).not.toBeNull());

    mockFetchStorageUsage.mockResolvedValueOnce({ usedBytes: 40, quotaBytes: 100 });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.usage).toEqual({ usedBytes: 40, quotaBytes: 100 });

    mockFetchStorageUsage.mockResolvedValueOnce(null);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.usage).toEqual({ usedBytes: 40, quotaBytes: 100 });
  });

  it("lets only the latest refresh report", async () => {
    mockFetchStorageUsage.mockResolvedValueOnce({ usedBytes: 1, quotaBytes: 100 });
    const { result } = renderHook(() => useStorageUsage());
    await waitFor(() => expect(result.current.usage).not.toBeNull());

    let resolveSlow!: (value: unknown) => void;
    mockFetchStorageUsage
      .mockReturnValueOnce(new Promise((resolve) => (resolveSlow = resolve)))
      .mockResolvedValueOnce({ usedBytes: 50, quotaBytes: 100 });
    await act(async () => {
      const slow = result.current.refresh();
      await result.current.refresh();
      resolveSlow({ usedBytes: 20, quotaBytes: 100 });
      await slow;
    });
    expect(result.current.usage).toEqual({ usedBytes: 50, quotaBytes: 100 });
  });
});
