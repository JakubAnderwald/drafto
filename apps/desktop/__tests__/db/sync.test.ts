const mockSynchronize = jest.fn().mockResolvedValue(undefined);
const mockSupabaseFrom = jest.fn();
const mockSupabaseRpc = jest.fn();

jest.mock("@nozbe/watermelondb/sync", () => ({
  synchronize: (...args: unknown[]) => mockSynchronize(...args),
}));

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  },
}));

import { syncDatabase, SyncNetworkError } from "@/db/sync";

describe("syncDatabase", () => {
  const mockDb = {} as Parameters<typeof syncDatabase>[0];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls synchronize with the database", async () => {
    await syncDatabase(mockDb);

    expect(mockSynchronize).toHaveBeenCalledWith(
      expect.objectContaining({
        database: mockDb,
        migrationsEnabledAtVersion: 1,
      }),
    );
  });

  it("returns conflict count of 0 when no conflicts", async () => {
    const result = await syncDatabase(mockDb);
    expect(result.conflictCount).toBe(0);
  });

  it("counts conflicts via the conflictResolver callback", async () => {
    mockSynchronize.mockImplementation(async (opts: Record<string, unknown>) => {
      const resolver = opts.conflictResolver as (
        table: string,
        local: unknown,
        remote: unknown,
        resolved: unknown,
      ) => unknown;
      // Simulate 3 conflicts
      resolver("notes", {}, {}, { id: "1" });
      resolver("notes", {}, {}, { id: "2" });
      resolver("notebooks", {}, {}, { id: "3" });
    });

    const result = await syncDatabase(mockDb);
    expect(result.conflictCount).toBe(3);
  });

  it("wraps network errors in SyncNetworkError", async () => {
    mockSynchronize.mockRejectedValue(new Error("Network request failed"));

    await expect(syncDatabase(mockDb)).rejects.toThrow(SyncNetworkError);
  });

  it("re-throws non-network errors as-is", async () => {
    const originalError = new Error("Some database error");
    mockSynchronize.mockRejectedValue(originalError);

    await expect(syncDatabase(mockDb)).rejects.toThrow(originalError);
  });

  describe("network error detection", () => {
    const networkErrorMessages = [
      "Network request failed",
      "network error",
      "Failed to fetch",
      "no internet",
      "internet connection lost",
      "network offline",
      "request timeout",
      "connection timeout",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
    ];

    for (const msg of networkErrorMessages) {
      it(`detects "${msg}" as a network error`, async () => {
        mockSynchronize.mockRejectedValue(new Error(msg));
        await expect(syncDatabase(mockDb)).rejects.toThrow(SyncNetworkError);
      });
    }

    it("does not treat generic errors as network errors", async () => {
      mockSynchronize.mockRejectedValue(new Error("Pull notebooks failed: invalid JSON"));

      await expect(syncDatabase(mockDb)).rejects.not.toThrow(SyncNetworkError);
    });
  });
});

describe("SyncNetworkError", () => {
  it("has correct name", () => {
    const err = new SyncNetworkError(new Error("test"));
    expect(err.name).toBe("SyncNetworkError");
  });

  it("preserves the original cause", () => {
    const cause = new Error("original");
    const err = new SyncNetworkError(cause);
    expect(err.syncCause).toBe(cause);
    expect(err.message).toBe("original");
  });

  it("handles non-Error causes", () => {
    const err = new SyncNetworkError("string cause");
    expect(err.message).toBe("Network error during sync");
    expect(err.syncCause).toBe("string cause");
  });
});
