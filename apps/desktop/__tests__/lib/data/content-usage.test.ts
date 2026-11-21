const mockRpc = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

import { fetchContentUsage } from "@/lib/data/content-usage";
import { STORAGE_USAGE_TIMEOUT_MS } from "@/lib/data/storage-usage";

describe("fetchContentUsage (ADR 0090)", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("reads the caller's note content usage and quota from the RPC", async () => {
    mockRpc.mockResolvedValue({ data: [{ used_bytes: 1024, quota_bytes: 26214400 }], error: null });

    await expect(fetchContentUsage()).resolves.toEqual({ usedBytes: 1024, quotaBytes: 26214400 });
    expect(mockRpc).toHaveBeenCalledWith("get_my_content_usage");
  });

  it("reads an unlimited quota as null", async () => {
    mockRpc.mockResolvedValue({ data: [{ used_bytes: "2048", quota_bytes: null }], error: null });

    await expect(fetchContentUsage()).resolves.toEqual({ usedBytes: 2048, quotaBytes: null });
  });

  it("returns null when the RPC reports an error (e.g. an older server)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "function not found" } });

    await expect(fetchContentUsage()).resolves.toBeNull();
  });

  it("returns null when the RPC throws", async () => {
    mockRpc.mockRejectedValue(new TypeError("Network request failed"));

    await expect(fetchContentUsage()).resolves.toBeNull();
  });

  it("returns null once the deadline passes", async () => {
    jest.useFakeTimers();
    mockRpc.mockReturnValue(new Promise(() => {}));

    const reading = fetchContentUsage();
    jest.advanceTimersByTime(STORAGE_USAGE_TIMEOUT_MS);

    await expect(reading).resolves.toBeNull();
  });
});
