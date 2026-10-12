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

    await expect(syncDatabase(mockDb)).resolves.toEqual({ remoteChangeCount: 0 });
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
    expect(fresh).toEqual({ remoteChangeCount: 0 });

    releaseStale();
    await stale;
    await syncDatabase(mockDb);
    expect(mockSynchronize).toHaveBeenCalledTimes(3);
  });
});
