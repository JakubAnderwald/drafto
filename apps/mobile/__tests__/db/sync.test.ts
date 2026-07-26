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

import { syncDatabase, resetSyncState } from "@/db/sync";

// Mirror of apps/desktop/__tests__/db/sync.test.ts's coalescing suite. Guards
// the module-level in-flight latch and the sign-out invalidation (resetSyncState)
// that stops a new user coalescing onto the previous session's still-running
// sync — the cross-account write vector fixed for issue #463.
describe("in-flight sync coalescing + resetSyncState", () => {
  const mockDb = {
    get: () => ({ query: () => ({ fetch: () => Promise.resolve([]) }) }),
  } as unknown as Parameters<typeof syncDatabase>[0];

  beforeEach(() => {
    jest.clearAllMocks();
    resetSyncState();
  });

  it("coalesces concurrent callers onto a single synchronize() run", async () => {
    let release!: () => void;
    mockSynchronize.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve(undefined))),
    );

    const p1 = syncDatabase(mockDb);
    const p2 = syncDatabase(mockDb);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockSynchronize).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it("starts a fresh synchronize() once the previous run has settled", async () => {
    await syncDatabase(mockDb);
    await syncDatabase(mockDb);
    expect(mockSynchronize).toHaveBeenCalledTimes(2);
  });

  it("clears the latch after a failed sync so a later call retries", async () => {
    mockSynchronize.mockRejectedValueOnce(new Error("Some database error"));
    await expect(syncDatabase(mockDb)).rejects.toThrow();

    await expect(syncDatabase(mockDb)).resolves.toEqual({ conflictCount: 0 });
    expect(mockSynchronize).toHaveBeenCalledTimes(2);
  });

  it("resetSyncState stops the next caller coalescing onto a stale in-flight sync", async () => {
    let releaseStale!: () => void;
    mockSynchronize.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseStale = () => resolve(undefined))),
    );

    const stale = syncDatabase(mockDb);
    resetSyncState();

    const fresh = await syncDatabase(mockDb);
    expect(mockSynchronize).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual({ conflictCount: 0 });

    releaseStale();
    await stale;
    await syncDatabase(mockDb);
    expect(mockSynchronize).toHaveBeenCalledTimes(3);
  });
});
