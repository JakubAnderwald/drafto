const mockSynchronize = jest.fn().mockResolvedValue(undefined);
const mockSupabaseFrom = jest.fn();
const mockSupabaseRpc = jest.fn();
const mockGetSession = jest.fn();

jest.mock("@nozbe/watermelondb/sync", () => ({
  synchronize: (...args: unknown[]) => mockSynchronize(...args),
}));

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
  },
}));

import { syncDatabase, SyncNetworkError, resetSyncState } from "@/db/sync";

describe("syncDatabase", () => {
  const mockDb = {
    get: () => ({ query: () => ({ fetch: () => Promise.resolve([]) }) }),
  } as unknown as Parameters<typeof syncDatabase>[0];

  beforeEach(() => {
    jest.clearAllMocks();
    // Several tests below swap synchronize()'s implementation; reset it so they
    // don't depend on running in declaration order.
    mockSynchronize.mockReset();
    mockSynchronize.mockResolvedValue(undefined);
    resetSyncState();
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

describe("in-flight sync coalescing + resetSyncState", () => {
  const mockDb = {
    get: () => ({ query: () => ({ fetch: () => Promise.resolve([]) }) }),
  } as unknown as Parameters<typeof syncDatabase>[0];

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks resets call records but NOT implementations, so an earlier
    // suite's persistent mockRejectedValue would leak in; restore the resolve
    // default explicitly. Also leave the module-level latch clean between tests.
    mockSynchronize.mockReset();
    mockSynchronize.mockResolvedValue(undefined);
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
    expect(r1).toBe(r2); // same SyncResult — second caller awaited the first run
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

    const stale = syncDatabase(mockDb); // in-flight, not yet settled
    resetSyncState(); // sign-out invalidates it

    const fresh = await syncDatabase(mockDb); // must run its own synchronize()
    expect(mockSynchronize).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual({ conflictCount: 0 });

    // The stale sync settling afterwards must not clobber the (now clear) latch:
    // a subsequent call still starts its own run.
    releaseStale();
    await stale;
    await syncDatabase(mockDb);
    expect(mockSynchronize).toHaveBeenCalledTimes(3);
  });
});

describe("pullChanges guards against an empty RLS result", () => {
  type SyncTable = "notebooks" | "notes" | "attachments";
  type LocalRow = { id: string; remoteId: string; _status: string };
  type PullResult = {
    changes: Record<SyncTable, { created: unknown[]; updated: unknown[]; deleted: string[] }>;
    timestamp: number;
  };
  type PullChanges = (params: { lastPulledAt?: number | null }) => Promise<PullResult>;

  const SESSION = { access_token: "token", user: { id: "user-1" } };

  /**
   * Fake local records per table, shaped the way detectServerDeletions reads
   * them (a plain `_status` field). Real WatermelonDB models expose sync state
   * only as `syncStatus` / `_raw._status`, so detection is inert in the app
   * today; see the note on detectServerDeletions in src/db/sync.ts.
   */
  function makeDb(rows: Partial<Record<SyncTable, unknown[]>>) {
    return {
      get: (table: SyncTable) => ({
        query: () => ({ fetch: () => Promise.resolve(rows[table] ?? []) }),
      }),
    } as unknown as Parameters<typeof syncDatabase>[0];
  }

  function synced(id: string, remoteId = id): LocalRow {
    return { id, remoteId, _status: "synced" };
  }

  /**
   * Answers `select("id")` (deletion detection) with the given server IDs and
   * the incremental `select("*")...gt()` pull with no changed rows.
   */
  function mockServerIds(ids: Partial<Record<SyncTable, string[]>>) {
    mockSupabaseFrom.mockImplementation((table: SyncTable) => ({
      select: (columns: string) => {
        const data = columns === "id" ? (ids[table] ?? []).map((id) => ({ id })) : [];
        const result = Promise.resolve({ data, error: null });
        return Object.assign(result, { gt: () => result });
      },
    }));
  }

  /**
   * Runs syncDatabase with synchronize() driving one pull (incremental unless
   * told otherwise), and returns that pull's result. A real first sync passes
   * `lastPulledAt: null` — WatermelonDB's getLastPulledAt returns null, not
   * undefined, when nothing has been pulled yet.
   */
  async function pull(
    db: Parameters<typeof syncDatabase>[0],
    { lastPulledAt }: { lastPulledAt?: number | null } = { lastPulledAt: 1000 },
  ): Promise<PullResult> {
    let result: PullResult | undefined;
    mockSynchronize.mockImplementation(async (opts: { pullChanges: PullChanges }) => {
      result = await opts.pullChanges({ lastPulledAt });
    });
    await syncDatabase(db);
    if (!result) throw new Error("pullChanges was not called");
    return result;
  }

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSynchronize.mockReset();
    resetSyncState();
    mockGetSession.mockResolvedValue({ data: { session: SESSION }, error: null });
    mockSupabaseRpc.mockResolvedValue({ data: "2025-06-10T00:00:00.000Z", error: null });
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("session gate", () => {
    it("aborts an incremental pull with no session before querying the server", async () => {
      mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
      mockServerIds({});

      const error = await pull(makeDb({ notebooks: [synced("nb-1")] })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Sync aborted: no authenticated session");
      expect(error).not.toBeInstanceOf(SyncNetworkError);
      expect(mockSupabaseFrom).not.toHaveBeenCalled();
      expect(mockSupabaseRpc).not.toHaveBeenCalled();
    });

    it("aborts a first pull with no session too", async () => {
      mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
      mockServerIds({});

      await expect(pull(makeDb({}), { lastPulledAt: null })).rejects.toThrow(
        "Sync aborted: no authenticated session",
      );
      expect(mockSupabaseFrom).not.toHaveBeenCalled();
    });

    it("keeps a network failure in getSession() retryable", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: { message: "Failed to fetch" },
      });
      mockServerIds({});

      const error = await pull(makeDb({})).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SyncNetworkError);
      expect((error as Error).message).toContain("Failed to fetch");
      expect(mockSupabaseFrom).not.toHaveBeenCalled();
    });

    it("keeps a rejected getSession() network call retryable", async () => {
      mockGetSession.mockRejectedValue(new Error("Network request failed"));
      mockServerIds({});

      await expect(pull(makeDb({}))).rejects.toThrow(SyncNetworkError);
      expect(mockSupabaseFrom).not.toHaveBeenCalled();
    });

    it("treats a non-network getSession() error as a hard failure", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: { message: "Invalid Refresh Token: Refresh Token Not Found" },
      });
      mockServerIds({});

      const error = await pull(makeDb({})).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(SyncNetworkError);
      expect((error as Error).message).toBe(
        "Sync aborted: session check failed: Invalid Refresh Token: Refresh Token Not Found",
      );
    });

    it("pulls normally when a session exists", async () => {
      mockServerIds({ notebooks: ["nb-1"] });

      const result = await pull(makeDb({ notebooks: [synced("nb-1")] }));

      expect(mockGetSession).toHaveBeenCalledTimes(1);
      expect(mockSupabaseFrom).toHaveBeenCalledWith("notebooks");
      expect(result.changes.notebooks.deleted).toEqual([]);
    });
  });

  describe("deletion detection", () => {
    it("flags nothing when every server ID set is empty but local synced rows exist", async () => {
      mockServerIds({});

      const result = await pull(
        makeDb({
          notebooks: [synced("nb-1"), synced("nb-2")],
          notes: [synced("n-1")],
          attachments: [synced("att-1")],
        }),
      );

      expect(result.changes.notebooks.deleted).toEqual([]);
      expect(result.changes.notes.deleted).toEqual([]);
      expect(result.changes.attachments.deleted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("skipping deletion detection for notebooks"),
      );
    });

    it("skips only the table whose server ID set is empty", async () => {
      mockServerIds({ notes: ["n-1"] });

      const result = await pull(
        makeDb({ notebooks: [synced("nb-1")], notes: [synced("n-1"), synced("n-2")] }),
      );

      expect(result.changes.notebooks.deleted).toEqual([]);
      expect(result.changes.notes.deleted).toEqual(["n-2"]);
      expect(result.changes.attachments.deleted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("skipping deletion detection for notebooks"),
      );
    });

    it("still flags a synced record the server no longer has", async () => {
      mockServerIds({ notebooks: ["nb-1"] });

      const result = await pull(
        makeDb({
          notebooks: [
            synced("nb-1"),
            synced("nb-2"),
            { id: "nb-3", remoteId: "nb-3", _status: "created" },
          ],
        }),
      );

      expect(result.changes.notebooks.deleted).toEqual(["nb-2"]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("matches local records to the server by remoteId, falling back to the local id", async () => {
      mockServerIds({ notes: ["remote-1", "n-2"] });

      const result = await pull(
        makeDb({
          notes: [synced("local-1", "remote-1"), synced("n-2", ""), synced("local-3", "remote-3")],
        }),
      );

      expect(result.changes.notes.deleted).toEqual(["local-3"]);
    });

    it("does not warn when an empty server table matches an empty local table", async () => {
      mockServerIds({});

      const result = await pull(
        makeDb({ notebooks: [{ id: "nb-new", remoteId: "nb-new", _status: "created" }] }),
      );

      expect(result.changes.notebooks.deleted).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("flags nothing on a real first pull (lastPulledAt: null) either", async () => {
      // Desktop's `isFirstSync` checks `=== undefined`, so a real first pull runs
      // deletion detection too; the empty-server-ID guard is what keeps it safe.
      mockServerIds({});

      const result = await pull(makeDb({ notebooks: [synced("nb-1")], notes: [synced("n-1")] }), {
        lastPulledAt: null,
      });

      expect(result.changes.notebooks.deleted).toEqual([]);
      expect(result.changes.notes.deleted).toEqual([]);
    });

    it("leaves real WatermelonDB records alone until detection is deliberately switched on", async () => {
      // Pins the dormant behaviour documented on detectServerDeletions: models
      // carry `syncStatus` / `_raw._status`, not `_status`, so nothing is flagged.
      // Reading `syncStatus` must wait until fetchAllIds pages past max_rows.
      mockServerIds({ notebooks: ["nb-1"] });
      const modelShaped = (id: string) => ({
        id,
        remoteId: id,
        syncStatus: "synced",
        _raw: { id, _status: "synced" },
      });

      const result = await pull(makeDb({ notebooks: [modelShaped("nb-1"), modelShaped("nb-2")] }));

      expect(result.changes.notebooks.deleted).toEqual([]);
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
