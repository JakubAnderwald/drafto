import { AppState } from "react-native";

const mockSynchronize = jest.fn().mockResolvedValue(undefined);
const mockSupabaseFrom = jest.fn();
const mockSupabaseRpc = jest.fn();
// The x-drafto-client tag; a getter so a test can switch platforms.
let mockClientTag = "mobile-ios";

jest.mock("@nozbe/watermelondb/sync", () => ({
  synchronize: (...args: unknown[]) => mockSynchronize(...args),
}));

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  },
  get clientTag() {
    return mockClientTag;
  },
}));

import { CONTENT_QUOTA_EXCEEDED_CODE } from "@drafto/shared";

import {
  ACTIVITY_PING_MAX_WAIT_MS,
  syncDatabase,
  resetSyncState,
  SyncNetworkError,
} from "@/db/sync";

const mockDb = {
  get: () => ({ query: () => ({ fetch: () => Promise.resolve([]) }) }),
} as unknown as Parameters<typeof syncDatabase>[0];

// Mirror of apps/desktop/__tests__/db/sync.test.ts's remoteChangeCount suite.
describe("remoteChangeCount (the 'updated from another device' toast)", () => {
  type Raw = Record<string, unknown>;
  type Resolution = [table: string, local: Raw, remote: Raw, resolved: Raw];

  // A stored note's content, and the same JSON as a pull hands it back:
  // JSON.stringify of the server's jsonb, whose keys are re-sorted.
  const CONTENT =
    '[{"type":"paragraph","content":[{"type":"text","text":"hi","styles":{}}],"children":[]}]';
  const CONTENT_FROM_JSONB =
    '[{"type":"paragraph","content":[{"text":"hi","type":"text","styles":{}}],"children":[]}]';
  const LOCAL_NOTE: Raw = {
    id: "note-1",
    _status: "synced",
    _changed: "",
    title: "Groceries",
    content: CONTENT,
    notebook_id: "nb-1",
    is_trashed: false,
    updated_at: 1_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSynchronize.mockReset();
    resetSyncState();
  });

  /** Runs a sync whose pull hands each record to the conflictResolver. */
  async function countFor(resolutions: Resolution[]): Promise<number> {
    const returned: unknown[] = [];
    mockSynchronize.mockImplementation(async (opts: Record<string, unknown>) => {
      const resolver = opts.conflictResolver as (...args: Resolution) => unknown;
      for (const args of resolutions) returned.push(resolver(...args));
    });
    const { remoteChangeCount } = await syncDatabase(mockDb);
    // Counting never changes the resolution WatermelonDB applies.
    expect(returned).toEqual(resolutions.map(([, , , resolved]) => resolved));
    return remoteChangeCount;
  }

  it("ignores the echo of this device's own push (reordered jsonb, new updated_at)", async () => {
    const echo = { ...LOCAL_NOTE, content: CONTENT_FROM_JSONB, updated_at: 2_000 };
    await expect(countFor([["notes", LOCAL_NOTE, echo, echo]])).resolves.toBe(0);
  });

  it("ignores a dirty local record and the echo of its previous push", async () => {
    // The note was edited again after its last push. WatermelonDB keeps the
    // locally changed column, so the resolved record shows the local text.
    const dirty = { ...LOCAL_NOTE, _status: "updated", _changed: "content", content: "[]" };
    const echo = { ...LOCAL_NOTE, content: CONTENT_FROM_JSONB, updated_at: 2_000 };
    const resolved = { ...echo, _status: "updated", _changed: "content", content: "[]" };
    await expect(countFor([["notes", dirty, echo, resolved]])).resolves.toBe(0);
  });

  it("counts a title changed on another device", async () => {
    const remote = { ...LOCAL_NOTE, title: "Shopping", updated_at: 2_000 };
    await expect(countFor([["notes", LOCAL_NOTE, remote, remote]])).resolves.toBe(1);
  });

  it("never counts attachments", async () => {
    const local = { id: "att-1", upload_status: "pending", local_uri: "file:///a.png" };
    const remote = { id: "att-1", upload_status: "uploaded", local_uri: null };
    await expect(countFor([["attachments", local, remote, remote]])).resolves.toBe(0);
  });
});

// Mirror of the pull tests in apps/desktop/__tests__/db/sync-mappers.test.ts.
describe("pullChanges", () => {
  type Changes = { created: unknown[]; updated: unknown[]; deleted: string[] };
  type PullChanges = (params: { lastPulledAt?: number | null }) => Promise<{
    changes: Record<"notebooks" | "notes" | "attachments", Changes>;
    timestamp: number;
  }>;

  const NOTEBOOK = {
    id: "nb-1",
    user_id: "user-1",
    name: "Work",
    created_at: "2025-06-01T12:00:00.000Z",
    updated_at: "2025-06-02T14:30:00.000Z",
  };
  const NOTE = {
    id: "note-1",
    notebook_id: "nb-1",
    user_id: "user-1",
    title: "Groceries",
    content: { type: "doc", content: [] },
    is_trashed: false,
    trashed_at: null,
    created_at: "2025-06-01T12:00:00.000Z",
    updated_at: "2025-06-02T14:30:00.000Z",
  };
  const ATTACHMENT = {
    id: "att-1",
    note_id: "note-1",
    user_id: "user-1",
    file_name: "photo.jpg",
    file_path: "user-1/note-1/photo.jpg",
    file_size: 100,
    mime_type: "image/jpeg",
    created_at: "2025-06-02T15:00:00.000Z",
  };
  const ROWS: Record<string, unknown[]> = {
    notebooks: [NOTEBOOK],
    notes: [NOTE],
    attachments: [ATTACHMENT],
  };

  /** Every cursor filter the pull applied, as `[table, column, iso]`. */
  let cursors: [string, string, string][];

  beforeEach(() => {
    jest.clearAllMocks();
    mockSynchronize.mockReset();
    resetSyncState();
    cursors = [];
    mockSupabaseFrom.mockImplementation((table: string) => ({
      select: () => {
        const result = Promise.resolve({ data: ROWS[table], error: null });
        return Object.assign(result, {
          gt: (column: string, iso: string) => {
            cursors.push([table, column, iso]);
            return result;
          },
        });
      },
    }));
    mockSupabaseRpc.mockResolvedValue({ data: "2025-06-10T00:00:00.000Z", error: null });
  });

  /** Runs syncDatabase with synchronize() driving one pull, and returns it. */
  async function pull(lastPulledAt: number | null | undefined) {
    let result: Awaited<ReturnType<PullChanges>> | undefined;
    mockSynchronize.mockImplementation(async (opts: { pullChanges: PullChanges }) => {
      result = await opts.pullChanges({ lastPulledAt });
    });
    await syncDatabase(mockDb);
    if (!result) throw new Error("pullChanges was not called");
    return result;
  }

  // WatermelonDB passes null; undefined (what its type suggests) works the same.
  it.each([null, undefined])(
    "pulls every row, with no cursor, as updated on a first sync (lastPulledAt: %p)",
    async (lastPulledAt) => {
      const { changes, timestamp } = await pull(lastPulledAt);

      expect(cursors).toEqual([]);
      for (const table of ["notebooks", "notes", "attachments"] as const) {
        expect(changes[table].created).toEqual([]);
        expect(changes[table].updated).toHaveLength(1);
        expect(changes[table].deleted).toEqual([]);
      }
      expect(changes.notes.updated[0]).toMatchObject({
        id: "note-1",
        remote_id: "note-1",
        content: JSON.stringify(NOTE.content),
      });
      expect(timestamp).toBe(Date.parse("2025-06-10T00:00:00.000Z"));
    },
  );

  it("pulls from the cursor and sends rows as updated on an incremental sync", async () => {
    const lastPulledAt = Date.parse("2025-06-01T00:00:00.000Z");

    const { changes } = await pull(lastPulledAt);

    const since = new Date(lastPulledAt).toISOString();
    expect(cursors).toEqual([
      ["notebooks", "updated_at", since],
      ["notes", "updated_at", since],
      ["attachments", "created_at", since],
    ]);
    expect(changes.notes.created).toEqual([]);
    expect(changes.notes.updated).toHaveLength(1);
  });

  it("tells synchronize that pulled records arrive as updated (sendCreatedAsUpdated)", async () => {
    mockSynchronize.mockResolvedValue(undefined);

    await syncDatabase(mockDb);

    expect(mockSynchronize).toHaveBeenCalledWith(
      expect.objectContaining({ sendCreatedAsUpdated: true }),
    );
  });
});

describe("pushChanges: attachments", () => {
  type PushChanges = (params: {
    changes: Record<string, { created: unknown[]; updated: unknown[]; deleted: string[] }>;
  }) => Promise<void>;

  const NO_CHANGES = { created: [], updated: [], deleted: [] };
  const UPLOADED = {
    id: "att-1",
    remote_id: "att-1",
    note_id: "note-1",
    user_id: "user-1",
    file_name: "photo.jpg",
    file_path: "user-1/note-1/photo.jpg",
    file_size: 100,
    mime_type: "image/jpeg",
    upload_status: "uploaded",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSynchronize.mockReset();
    resetSyncState();
  });

  async function pushAttachments(created: unknown[]): Promise<jest.Mock> {
    const upsert = jest.fn().mockResolvedValue({ error: null });
    mockSupabaseFrom.mockReturnValue({ upsert });
    mockSynchronize.mockImplementation(async (opts: { pushChanges: PushChanges }) => {
      await opts.pushChanges({
        changes: {
          notebooks: NO_CHANGES,
          notes: NO_CHANGES,
          attachments: { created, updated: [], deleted: [] },
        },
      });
    });
    await syncDatabase(mockDb);
    return upsert;
  }

  it("inserts uploaded attachments with ON CONFLICT DO NOTHING", async () => {
    // uploadSingleAttachment() already inserted the row, and the attachments
    // table has no UPDATE policy, so a plain upsert is rejected by RLS.
    const upsert = await pushAttachments([UPLOADED, { ...UPLOADED, upload_status: "pending" }]);

    expect(mockSupabaseFrom).toHaveBeenCalledWith("attachments");
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "att-1", file_name: "photo.jpg" })],
      { onConflict: "id", ignoreDuplicates: true },
    );
  });

  it("does not call the server when every created attachment is still pending", async () => {
    const upsert = await pushAttachments([{ ...UPLOADED, upload_status: "pending" }]);
    expect(upsert).not.toHaveBeenCalled();
  });
});

// Mirror of the content quota suite in apps/desktop/__tests__/db/sync.test.ts.
describe("pushChanges: notes refused for the content quota (ADR 0090)", () => {
  type Changes = { created: unknown[]; updated: unknown[]; deleted: string[] };
  type PushChanges = (params: { changes: Record<string, Changes> }) => Promise<unknown>;

  const NO_CHANGES: Changes = { created: [], updated: [], deleted: [] };
  const QUOTA_ERROR = {
    code: "P0001",
    message: CONTENT_QUOTA_EXCEEDED_CODE,
    details: "used_bytes=100 quota_bytes=200 note_bytes=150",
  };
  const note = (id: string) => ({
    id,
    remote_id: id,
    notebook_id: "nb-1",
    user_id: "user-1",
    title: id,
    content: JSON.stringify([{ type: "paragraph" }]),
    is_trashed: false,
    trashed_at: null,
  });
  const attachment = (id: string, noteId: string) => ({
    id,
    remote_id: id,
    note_id: noteId,
    user_id: "user-1",
    file_name: `${id}.png`,
    file_path: `user-1/${noteId}/${id}.png`,
    file_size: 10,
    mime_type: "image/png",
    upload_status: "uploaded",
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSynchronize.mockReset();
    resetSyncState();
  });

  /** Runs one push with <changes>; <server> answers each notes/attachments call. */
  async function push(
    changes: Record<string, Changes>,
    server: {
      noteUpsert?: (rows: unknown) => { error: unknown };
      noteUpdate?: (id: string) => { error: unknown };
    },
  ) {
    const noteUpsert = jest.fn(
      async (rows: unknown) => server.noteUpsert?.(rows) ?? { error: null },
    );
    const attachmentUpsert = jest.fn().mockResolvedValue({ error: null });
    const updatedIds: string[] = [];
    mockSupabaseFrom.mockImplementation((table: string) => ({
      upsert: table === "notes" ? noteUpsert : attachmentUpsert,
      update: () => ({
        eq: async (_col: string, id: string) => {
          updatedIds.push(id);
          return server.noteUpdate?.(id) ?? { error: null };
        },
      }),
      delete: () => ({ in: jest.fn().mockResolvedValue({ error: null }) }),
    }));
    let pushResult: unknown;
    mockSynchronize.mockImplementation(async (opts: { pushChanges: PushChanges }) => {
      pushResult = await opts.pushChanges({
        changes: { notebooks: NO_CHANGES, notes: NO_CHANGES, attachments: NO_CHANGES, ...changes },
      });
    });
    const result = await syncDatabase(mockDb);
    return { result, pushResult, noteUpsert, attachmentUpsert, updatedIds };
  }

  it("pushes new notes one at a time after a refused batch, holding back only the refused ones", async () => {
    const { result, pushResult, noteUpsert, attachmentUpsert } = await push(
      {
        notes: { created: [note("a"), note("b")], updated: [], deleted: [] },
        attachments: {
          created: [attachment("att-a", "a"), attachment("att-b", "b")],
          updated: [],
          deleted: [],
        },
      },
      {
        noteUpsert: (rows) =>
          Array.isArray(rows) || (rows as { id: string }).id === "b"
            ? { error: QUOTA_ERROR }
            : { error: null },
      },
    );

    // The batch, then each row alone.
    expect(noteUpsert).toHaveBeenCalledTimes(3);
    expect(noteUpsert.mock.calls[1][0]).toEqual(expect.objectContaining({ id: "a" }));
    expect(noteUpsert.mock.calls[2][0]).toEqual(expect.objectContaining({ id: "b" }));
    // The refused note's attachment waits for its note; the other goes out.
    expect(attachmentUpsert).toHaveBeenCalledWith([expect.objectContaining({ id: "att-a" })], {
      onConflict: "id",
      ignoreDuplicates: true,
    });
    expect(pushResult).toEqual({
      experimentalRejectedIds: { notes: ["b"], attachments: ["att-b"] },
    });
    expect(result).toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 1,
      contentUsage: { usedBytes: 100, quotaBytes: 200 },
    });
  });

  it("keeps pushing the other edits after a refused one", async () => {
    const { pushResult, updatedIds, result } = await push(
      { notes: { created: [], updated: [note("a"), note("b"), note("c")], deleted: [] } },
      { noteUpdate: (id) => (id === "b" ? { error: QUOTA_ERROR } : { error: null }) },
    );

    expect(updatedIds).toEqual(["a", "b", "c"]);
    expect(pushResult).toEqual({ experimentalRejectedIds: { notes: ["b"], attachments: [] } });
    expect(result.contentQuotaRefused).toBe(1);
  });

  it("returns nothing to reject when every note fits", async () => {
    const { pushResult, noteUpsert, result } = await push(
      { notes: { created: [note("a")], updated: [note("b")], deleted: [] } },
      {},
    );

    expect(noteUpsert).toHaveBeenCalledTimes(1);
    expect(pushResult).toBeUndefined();
    expect(result).toEqual({ remoteChangeCount: 0, contentQuotaRefused: 0, contentUsage: null });
  });

  it("fails the sync as before for any other error", async () => {
    mockSupabaseFrom.mockImplementation(() => ({
      upsert: jest.fn().mockResolvedValue({ error: { message: "permission denied" } }),
    }));
    mockSynchronize.mockImplementation(async (opts: { pushChanges: PushChanges }) => {
      await opts.pushChanges({
        changes: {
          notebooks: NO_CHANGES,
          notes: { created: [note("a")], updated: [], deleted: [] },
          attachments: NO_CHANGES,
        },
      });
    });

    await expect(syncDatabase(mockDb)).rejects.toThrow(
      "Push notes (create) failed: permission denied",
    );
  });

  it("fails the sync when a single-row retry hits another error", async () => {
    await expect(
      push(
        { notes: { created: [note("a"), note("b")], updated: [], deleted: [] } },
        {
          noteUpsert: (rows) =>
            Array.isArray(rows) ? { error: QUOTA_ERROR } : { error: { message: "boom" } },
        },
      ),
    ).rejects.toThrow("Push notes (create) failed: boom");
  });

  it("fails the sync when an edit hits another error", async () => {
    await expect(
      push(
        { notes: { created: [], updated: [note("a")], deleted: [] } },
        { noteUpdate: () => ({ error: { message: "boom" } }) },
      ),
    ).rejects.toThrow("Push note update failed: boom");
  });
});

// Mirror of apps/desktop/__tests__/db/sync.test.ts's coalescing suite. Guards
// the module-level in-flight latch and the sign-out invalidation (resetSyncState)
// that stops a new user coalescing onto the previous session's still-running
// sync — the cross-account write vector fixed for issue #463.
describe("in-flight sync coalescing + resetSyncState", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

    await expect(syncDatabase(mockDb)).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });
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
    expect(fresh).toEqual({ remoteChangeCount: 0, contentQuotaRefused: 0, contentUsage: null });

    releaseStale();
    await stale;
    await syncDatabase(mockDb);
    expect(mockSynchronize).toHaveBeenCalledTimes(3);
  });
});

// Mirror of apps/desktop/__tests__/db/sync.test.ts's activity ping suite,
// plus the tags only mobile has.
describe("activity ping after a successful sync (ADR-0088)", () => {
  const TODAY = "2026-11-13";
  const TOMORROW = "2026-11-14";

  /** A database whose WatermelonDB localStorage keeps JSON in memory. */
  function makeDb() {
    const store = new Map<string, string>();
    return {
      get: () => ({ query: () => ({ fetch: () => Promise.resolve([]) }) }),
      localStorage: {
        get: async (key: string): Promise<unknown> => {
          const json = store.get(key);
          return json === undefined ? undefined : JSON.parse(json);
        },
        set: async (key: string, value: unknown): Promise<void> => {
          store.set(key, JSON.stringify(value));
        },
      },
    } as unknown as Parameters<typeof syncDatabase>[0];
  }

  /** The record_activity calls made so far (get_server_time is the other RPC). */
  function pings(): unknown[][] {
    return mockSupabaseRpc.mock.calls.filter(([fn]) => fn === "record_activity");
  }

  function ping(days: string[], tag = "mobile-ios"): unknown[] {
    return ["record_activity", { p_days: days, p_client: tag }];
  }

  let warnSpy: jest.SpyInstance;
  // The preset's AppState mock, put back after each test.
  const appStateBefore = AppState.currentState;

  beforeEach(() => {
    // Fake only Date, so "today" is fixed while promises and timers run as usual.
    jest.useFakeTimers({
      now: new Date(`${TODAY}T10:00:00.000Z`),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    jest.clearAllMocks();
    mockSynchronize.mockReset();
    mockSynchronize.mockResolvedValue(undefined);
    mockSupabaseRpc.mockReset();
    mockSupabaseRpc.mockResolvedValue({ data: null, error: null });
    mockClientTag = "mobile-ios";
    resetSyncState();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    // The user has the app in front unless a test says otherwise.
    AppState.currentState = "active";
  });

  afterEach(() => {
    jest.useRealTimers();
    warnSpy.mockRestore();
    AppState.currentState = appStateBefore;
  });

  it.each(["mobile-ios", "mobile-android"])(
    "records today as %s once synchronize() has succeeded",
    async (tag) => {
      mockClientTag = tag;

      await expect(syncDatabase(makeDb())).resolves.toEqual({
        remoteChangeCount: 0,
        contentQuotaRefused: 0,
        contentUsage: null,
      });

      expect(pings()).toEqual([ping([TODAY], tag)]);
      expect(mockSupabaseRpc.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockSynchronize.mock.invocationCallOrder[0],
      );
    },
  );

  it("sends nothing while syncs fail, then every queued day with the next one that succeeds", async () => {
    const db = makeDb();
    mockSynchronize.mockRejectedValueOnce(new Error("Network request failed"));
    await expect(syncDatabase(db)).rejects.toThrow(SyncNetworkError);

    jest.setSystemTime(new Date(`${TOMORROW}T08:00:00.000Z`));
    const original = new Error("Some database error");
    mockSynchronize.mockRejectedValueOnce(original);
    await expect(syncDatabase(db)).rejects.toBe(original);
    expect(pings()).toEqual([]);

    await expect(syncDatabase(db)).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });
    expect(pings()).toEqual([ping([TODAY, TOMORROW])]);
  });

  it("doesn't fail the sync when the ping fails, and the next sync sends it again", async () => {
    const db = makeDb();
    mockSupabaseRpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });
    await expect(syncDatabase(db)).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });

    mockSupabaseRpc.mockRejectedValueOnce(new Error("Network request failed"));
    await expect(syncDatabase(db)).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });

    await syncDatabase(db);
    await syncDatabase(db);
    expect(pings()).toEqual([ping([TODAY]), ping([TODAY]), ping([TODAY])]);
  });

  it.each(["background", "inactive", "unknown"] as const)(
    "marks no day for a sync started while the app is %s",
    async (state) => {
      // A reconnect or retry sync while the app sits behind other windows, or
      // (macOS) keeps running with its window closed: nobody opened Drafto.
      AppState.currentState = state;
      const db = makeDb();
      await expect(syncDatabase(db)).resolves.toEqual({
        remoteChangeCount: 0,
        contentQuotaRefused: 0,
        contentUsage: null,
      });
      expect(pings()).toEqual([]);

      AppState.currentState = "active";
      await syncDatabase(db);
      expect(pings()).toEqual([ping([TODAY])]);
    },
  );

  it("sends days queued in front with a sync that runs in the background", async () => {
    const db = makeDb();
    mockSynchronize.mockRejectedValueOnce(new Error("Network request failed"));
    await expect(syncDatabase(db)).rejects.toThrow(SyncNetworkError);

    // The network comes back after the user has switched away.
    AppState.currentState = "background";
    await expect(syncDatabase(db)).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });
    expect(pings()).toEqual([ping([TODAY])]);
  });

  it("pings once a day, and again on the next UTC day", async () => {
    const db = makeDb();
    await syncDatabase(db);
    await syncDatabase(db);
    expect(pings()).toEqual([ping([TODAY])]);

    jest.setSystemTime(new Date(`${TOMORROW}T00:05:00.000Z`));
    await syncDatabase(db);
    expect(pings()).toEqual([ping([TODAY]), ping([TOMORROW])]);
  });

  it("returns without waiting for a ping that never answers, and keeps its days", async () => {
    // Fake setTimeout too, so the wait limit passes at once.
    jest.useFakeTimers({
      now: new Date(`${TODAY}T10:00:00.000Z`),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
      ],
    });
    const db = makeDb();
    mockSupabaseRpc.mockImplementationOnce(() => new Promise(() => {}));

    const first = syncDatabase(db);
    await jest.advanceTimersByTimeAsync(ACTIVITY_PING_MAX_WAIT_MS);
    await expect(first).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });

    // The latch is free, so the next sync runs its own synchronize(), and the
    // unanswered day is still queued, so it goes again.
    await expect(syncDatabase(db)).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });
    expect(mockSynchronize).toHaveBeenCalledTimes(2);
    expect(pings()).toEqual([ping([TODAY]), ping([TODAY])]);
  });

  it("makes one synchronize() and one ping for coalesced concurrent callers", async () => {
    const db = makeDb();
    let release!: () => void;
    mockSynchronize.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve(undefined))),
    );

    const p1 = syncDatabase(db);
    const p2 = syncDatabase(db);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(r2);
    expect(mockSynchronize).toHaveBeenCalledTimes(1);
    expect(pings()).toEqual([ping([TODAY])]);
  });

  it("syncs without pinging on a build whose tag usage_daily doesn't accept", async () => {
    mockClientTag = "mobile";

    await expect(syncDatabase(makeDb())).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });

    expect(mockSynchronize).toHaveBeenCalledTimes(1);
    expect(pings()).toEqual([]);
  });

  it("frees the latch once synchronize() resolves, so a caller arriving during the ping syncs on its own", async () => {
    const db = makeDb();
    let release!: () => void;
    let called!: () => void;
    const rpcCalled = new Promise<void>((resolve) => (called = resolve));
    mockSupabaseRpc.mockImplementationOnce(() => {
      called();
      return new Promise((resolve) => (release = () => resolve({ data: null, error: null })));
    });

    const first = syncDatabase(db);
    await rpcCalled;
    // Sign-out's final sync, or a follow-up pass for an edit made after the
    // first push: it must push again, not join a sync whose push is done.
    await expect(syncDatabase(db)).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });
    expect(mockSynchronize).toHaveBeenCalledTimes(2);

    release();
    await expect(first).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });
  });

  it("sends no ping for a sync that resetSyncState superseded", async () => {
    const db = makeDb();
    let release!: () => void;
    mockSynchronize.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve(undefined))),
    );

    const stale = syncDatabase(db);
    resetSyncState();
    release();
    await expect(stale).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });

    expect(pings()).toEqual([]);
  });

  it("sends no ping when resetSyncState runs after synchronize() but before today's mark settles", async () => {
    const db = makeDb();
    // A failed sync leaves today queued for the user who is about to sign out.
    mockSynchronize.mockRejectedValueOnce(new Error("Network request failed"));
    await expect(syncDatabase(db)).rejects.toThrow(SyncNetworkError);
    await new Promise<void>((resolve) => setImmediate(() => resolve()));

    // The next sync's mark is held on its storage read.
    const storage = (db as unknown as { localStorage: { get(key: string): Promise<unknown> } })
      .localStorage;
    const read = storage.get.bind(storage);
    let releaseMark!: () => void;
    storage.get = (key) => {
      storage.get = read;
      return new Promise((resolve) => (releaseMark = () => resolve(read(key))));
    };

    const stale = syncDatabase(db);
    // Let synchronize() resolve, so the sync is already waiting on its mark.
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(mockSynchronize).toHaveBeenCalledTimes(2);
    resetSyncState(); // sign-out
    releaseMark();
    await expect(stale).resolves.toEqual({
      remoteChangeCount: 0,
      contentQuotaRefused: 0,
      contentUsage: null,
    });

    expect(pings()).toEqual([]);
  });
});
