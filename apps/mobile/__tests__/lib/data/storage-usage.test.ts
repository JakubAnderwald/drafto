const mockRpc = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

import { STORAGE_USAGE_TIMEOUT_MS, fetchStorageUsage } from "@/lib/data/storage-usage";

describe("fetchStorageUsage", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("reads the caller's usage and quota from the RPC", async () => {
    mockRpc.mockResolvedValue({ data: [{ used_bytes: 1024, quota_bytes: 52428800 }], error: null });

    await expect(fetchStorageUsage()).resolves.toEqual({ usedBytes: 1024, quotaBytes: 52428800 });
    expect(mockRpc).toHaveBeenCalledWith("get_my_storage_usage");
  });

  it("reads an unlimited quota as null", async () => {
    mockRpc.mockResolvedValue({ data: [{ used_bytes: "2048", quota_bytes: null }], error: null });

    await expect(fetchStorageUsage()).resolves.toEqual({ usedBytes: 2048, quotaBytes: null });
  });

  it("returns null when the RPC reports an error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "function not found" } });

    await expect(fetchStorageUsage()).resolves.toBeNull();
  });

  it("returns null when the RPC throws", async () => {
    mockRpc.mockRejectedValue(new TypeError("Network request failed"));

    await expect(fetchStorageUsage()).resolves.toBeNull();
  });

  it("returns null once the deadline passes, so a stalled read doesn't hold up its caller", async () => {
    jest.useFakeTimers();
    mockRpc.mockReturnValue(new Promise(() => {}));

    const reading = fetchStorageUsage();
    jest.advanceTimersByTime(STORAGE_USAGE_TIMEOUT_MS);

    await expect(reading).resolves.toBeNull();
  });

  it("doesn't leave its deadline timer running after an answer", async () => {
    jest.useFakeTimers();
    mockRpc.mockResolvedValue({ data: [{ used_bytes: 0, quota_bytes: 52428800 }], error: null });

    await expect(fetchStorageUsage()).resolves.toEqual({ usedBytes: 0, quotaBytes: 52428800 });
    expect(jest.getTimerCount()).toBe(0);
  });
});
