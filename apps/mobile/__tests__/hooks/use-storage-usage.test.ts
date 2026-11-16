import { act, renderHook, waitFor } from "@testing-library/react-native";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "@drafto/shared";
import type { StorageUsage } from "@drafto/shared";

import { useStorageUsage } from "@/hooks/use-storage-usage";

const mockFetchStorageUsage = jest.fn();
jest.mock("@/lib/data/storage-usage", () => ({
  fetchStorageUsage: () => mockFetchStorageUsage(),
}));

const HALF: StorageUsage = {
  usedBytes: DEFAULT_STORAGE_QUOTA_BYTES / 2,
  quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
};
const FULL: StorageUsage = {
  usedBytes: DEFAULT_STORAGE_QUOTA_BYTES,
  quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useStorageUsage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads the usage on mount", async () => {
    mockFetchStorageUsage.mockResolvedValue(HALF);

    const { result } = renderHook(() => useStorageUsage());

    expect(result.current.loading).toBe(true);
    expect(result.current.usage).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.usage).toEqual(HALF);
  });

  it("settles to null when the usage can't be read", async () => {
    mockFetchStorageUsage.mockResolvedValue(null);

    const { result } = renderHook(() => useStorageUsage());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.usage).toBeNull();
  });

  it("reads again when the refresh key changes, keeping the old reading meanwhile", async () => {
    mockFetchStorageUsage.mockResolvedValueOnce(HALF);
    const { result, rerender } = renderHook(({ key }: { key: number }) => useStorageUsage(key), {
      initialProps: { key: 1 },
    });
    await waitFor(() => expect(result.current.usage).toEqual(HALF));

    const next = deferred<StorageUsage>();
    mockFetchStorageUsage.mockReturnValueOnce(next.promise);
    rerender({ key: 2 });

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.usage).toEqual(HALF);
    await act(async () => {
      next.resolve(FULL);
    });
    expect(result.current.usage).toEqual(FULL);
    expect(result.current.loading).toBe(false);
    expect(mockFetchStorageUsage).toHaveBeenCalledTimes(2);
  });

  it("does not let a slow older read overwrite a newer one", async () => {
    const slow = deferred<StorageUsage>();
    mockFetchStorageUsage.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(FULL);
    const { result } = renderHook(() => useStorageUsage());

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.usage).toEqual(FULL);

    await act(async () => {
      slow.resolve(HALF);
    });
    expect(result.current.usage).toEqual(FULL);
  });
});
