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

import { syncDatabase } from "@/db/sync";

type SynchronizeOpts = {
  pullChanges: (params: { lastPulledAt?: number }) => Promise<{
    changes: Record<string, { created: unknown[]; updated: unknown[]; deleted: string[] }>;
    timestamp: number;
  }>;
  pushChanges: (params: {
    changes: Record<string, { created: unknown[]; updated: unknown[]; deleted: string[] }>;
  }) => Promise<void>;
};

const mockDb = {} as Parameters<typeof syncDatabase>[0];

// Helper to build a Supabase query chain that resolves with data
function mockQueryChain(data: unknown[], error: null | { message: string } = null) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    then: undefined as unknown,
  };
  // Make the chain thenable so `await query` resolves
  Object.defineProperty(chain, "then", {
    value: (resolve: (val: { data: unknown[]; error: typeof error }) => void) =>
      Promise.resolve({ data, error }).then(resolve),
    enumerable: false,
  });
  return chain;
}

// Sample Supabase rows
const sampleNotebookRow = {
  id: "nb-1",
  user_id: "user-1",
  name: "My Notebook",
  created_at: "2025-06-01T12:00:00.000Z",
  updated_at: "2025-06-02T14:30:00.000Z",
};

const sampleNoteRow = {
  id: "note-1",
  notebook_id: "nb-1",
  user_id: "user-1",
  title: "Test Note",
  content: { type: "doc", content: [{ type: "paragraph" }] },
  is_trashed: false,
  trashed_at: null,
  created_at: "2025-06-01T12:00:00.000Z",
  updated_at: "2025-06-02T14:30:00.000Z",
};

const sampleAttachmentRow = {
  id: "att-1",
  note_id: "note-1",
  user_id: "user-1",
  file_name: "photo.png",
  file_path: "attachments/photo.png",
  file_size: 12345,
  mime_type: "image/png",
  created_at: "2025-06-01T12:00:00.000Z",
};

describe("sync pull/push behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("pullChanges", () => {
    beforeEach(() => {
      // Default: rpc returns server time
      mockSupabaseRpc.mockResolvedValue({
        data: "2025-06-10T00:00:00.000Z",
        error: null,
      });
    });

    function setupPullMocks(
      notebooks: unknown[] = [],
      notes: unknown[] = [],
      attachments: unknown[] = [],
    ) {
      // Each call to supabase.from(table) returns a chain
      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === "notebooks") return mockQueryChain(notebooks);
        if (table === "notes") return mockQueryChain(notes);
        if (table === "attachments") return mockQueryChain(attachments);
        return mockQueryChain([]);
      });

      // Let synchronize invoke pullChanges (and a no-op pushChanges)
      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pullChanges({ lastPulledAt: undefined });
      });
    }

    it("returns all records as created on first sync (lastPulledAt=undefined)", async () => {
      setupPullMocks([sampleNotebookRow], [sampleNoteRow], [sampleAttachmentRow]);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: undefined });

        expect(result.changes.notebooks.created).toHaveLength(1);
        expect(result.changes.notebooks.updated).toHaveLength(0);
        expect(result.changes.notes.created).toHaveLength(1);
        expect(result.changes.notes.updated).toHaveLength(0);
        expect(result.changes.attachments.created).toHaveLength(1);
        expect(result.changes.attachments.updated).toHaveLength(0);
      });

      await syncDatabase(mockDb);
    });

    it("returns all records as updated on incremental sync", async () => {
      setupPullMocks([sampleNotebookRow], [sampleNoteRow], []);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: 1000 });

        expect(result.changes.notebooks.created).toHaveLength(0);
        expect(result.changes.notebooks.updated).toHaveLength(1);
        expect(result.changes.notes.created).toHaveLength(0);
        expect(result.changes.notes.updated).toHaveLength(1);
      });

      await syncDatabase(mockDb);
    });

    it("maps notebook rows correctly", async () => {
      setupPullMocks([sampleNotebookRow]);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: undefined });
        const nb = result.changes.notebooks.created[0] as Record<string, unknown>;

        expect(nb.id).toBe("nb-1");
        expect(nb.remote_id).toBe("nb-1");
        expect(nb.user_id).toBe("user-1");
        expect(nb.name).toBe("My Notebook");
        expect(nb.created_at).toBe(new Date("2025-06-01T12:00:00.000Z").getTime());
        expect(nb.updated_at).toBe(new Date("2025-06-02T14:30:00.000Z").getTime());
      });

      await syncDatabase(mockDb);
    });

    it("maps note rows with content as JSON string", async () => {
      setupPullMocks([], [sampleNoteRow]);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: undefined });
        const note = result.changes.notes.created[0] as Record<string, unknown>;

        expect(note.id).toBe("note-1");
        expect(note.remote_id).toBe("note-1");
        expect(note.content).toBe(JSON.stringify(sampleNoteRow.content));
        expect(note.is_trashed).toBe(false);
        expect(note.trashed_at).toBeNull();
      });

      await syncDatabase(mockDb);
    });

    it("maps note rows with trashed_at as timestamp", async () => {
      const trashedNote = {
        ...sampleNoteRow,
        is_trashed: true,
        trashed_at: "2025-06-05T10:00:00.000Z",
      };
      setupPullMocks([], [trashedNote]);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: undefined });
        const note = result.changes.notes.created[0] as Record<string, unknown>;

        expect(note.is_trashed).toBe(true);
        expect(note.trashed_at).toBe(new Date("2025-06-05T10:00:00.000Z").getTime());
      });

      await syncDatabase(mockDb);
    });

    it("maps note with null content", async () => {
      const noteNullContent = { ...sampleNoteRow, content: null };
      setupPullMocks([], [noteNullContent]);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: undefined });
        const note = result.changes.notes.created[0] as Record<string, unknown>;

        expect(note.content).toBeNull();
      });

      await syncDatabase(mockDb);
    });

    it("maps attachment rows with local_uri=null and upload_status=uploaded", async () => {
      setupPullMocks([], [], [sampleAttachmentRow]);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: undefined });
        const att = result.changes.attachments.created[0] as Record<string, unknown>;

        expect(att.id).toBe("att-1");
        expect(att.remote_id).toBe("att-1");
        expect(att.local_uri).toBeNull();
        expect(att.upload_status).toBe("uploaded");
        expect(att.file_name).toBe("photo.png");
        expect(att.file_size).toBe(12345);
      });

      await syncDatabase(mockDb);
    });

    it("uses server timestamp from rpc", async () => {
      setupPullMocks();
      mockSupabaseRpc.mockResolvedValue({
        data: "2025-06-10T12:00:00.000Z",
        error: null,
      });

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: undefined });
        expect(result.timestamp).toBe(new Date("2025-06-10T12:00:00.000Z").getTime());
      });

      await syncDatabase(mockDb);
    });

    it("falls back to client time when rpc fails", async () => {
      setupPullMocks();
      mockSupabaseRpc.mockResolvedValue({
        data: null,
        error: { message: "function not found" },
      });

      const before = Date.now() - 5000;

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        const result = await opts.pullChanges({ lastPulledAt: undefined });
        const after = Date.now() - 5000;
        // Fallback uses Date.now() - 5000
        expect(result.timestamp).toBeGreaterThanOrEqual(before);
        expect(result.timestamp).toBeLessThanOrEqual(after);
      });

      await syncDatabase(mockDb);
    });

    it("applies gt filter on incremental sync", async () => {
      const chain = mockQueryChain([]);
      mockSupabaseFrom.mockReturnValue(chain);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pullChanges({ lastPulledAt: 1717200000000 });
      });

      await syncDatabase(mockDb);

      // gt should have been called with the timestamp column and ISO string
      expect(chain.gt).toHaveBeenCalled();
      const gtCall = chain.gt.mock.calls[0];
      expect(gtCall[1]).toBe(new Date(1717200000000).toISOString());
    });

    it("throws when supabase fetch fails", async () => {
      const errorChain = mockQueryChain([], { message: "connection refused" });
      mockSupabaseFrom.mockReturnValue(errorChain);

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await expect(opts.pullChanges({ lastPulledAt: undefined })).rejects.toThrow(
          /Pull .* failed: connection refused/,
        );
      });

      await syncDatabase(mockDb);
    });
  });

  describe("pushChanges", () => {
    function setupPushMocks() {
      const chains: Record<string, ReturnType<typeof mockQueryChain>> = {};
      mockSupabaseFrom.mockImplementation((table: string) => {
        if (!chains[table]) {
          chains[table] = mockQueryChain([]);
        }
        return chains[table];
      });
      return chains;
    }

    it("pushes created notebooks via upsert", async () => {
      const chains = setupPushMocks();

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: {
              created: [{ id: "local-1", remote_id: "nb-1", user_id: "user-1", name: "New NB" }],
              updated: [],
              deleted: [],
            },
            notes: { created: [], updated: [], deleted: [] },
            attachments: { created: [], updated: [], deleted: [] },
          },
        });
      });

      await syncDatabase(mockDb);

      expect(mockSupabaseFrom).toHaveBeenCalledWith("notebooks");
      expect(chains["notebooks"].upsert).toHaveBeenCalledWith([
        { id: "nb-1", user_id: "user-1", name: "New NB" },
      ]);
    });

    it("pushes updated notebooks via update with remote_id", async () => {
      const chains = setupPushMocks();

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: {
              created: [],
              updated: [{ id: "local-1", remote_id: "nb-1", user_id: "user-1", name: "Renamed" }],
              deleted: [],
            },
            notes: { created: [], updated: [], deleted: [] },
            attachments: { created: [], updated: [], deleted: [] },
          },
        });
      });

      await syncDatabase(mockDb);

      expect(chains["notebooks"].update).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Renamed" }),
      );
      expect(chains["notebooks"].eq).toHaveBeenCalledWith("id", "nb-1");
    });

    it("pushes deleted notebooks via delete().in()", async () => {
      const chains = setupPushMocks();

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: { created: [], updated: [], deleted: ["nb-del-1", "nb-del-2"] },
            notes: { created: [], updated: [], deleted: [] },
            attachments: { created: [], updated: [], deleted: [] },
          },
        });
      });

      await syncDatabase(mockDb);

      expect(chains["notebooks"].delete).toHaveBeenCalled();
      expect(chains["notebooks"].in).toHaveBeenCalledWith("id", ["nb-del-1", "nb-del-2"]);
    });

    it("pushes created notes with content parsed from JSON string", async () => {
      const chains = setupPushMocks();
      const contentObj = { type: "doc", content: [] };

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: { created: [], updated: [], deleted: [] },
            notes: {
              created: [
                {
                  id: "local-n1",
                  remote_id: "note-1",
                  notebook_id: "nb-1",
                  user_id: "user-1",
                  title: "My Note",
                  content: JSON.stringify(contentObj),
                  is_trashed: false,
                  trashed_at: null,
                },
              ],
              updated: [],
              deleted: [],
            },
            attachments: { created: [], updated: [], deleted: [] },
          },
        });
      });

      await syncDatabase(mockDb);

      expect(chains["notes"].upsert).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "note-1",
          title: "My Note",
          content: contentObj,
        }),
      ]);
    });

    it("pushes updated notes with content parsed from JSON", async () => {
      const chains = setupPushMocks();
      const contentObj = { type: "doc", content: [{ type: "paragraph" }] };

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: { created: [], updated: [], deleted: [] },
            notes: {
              created: [],
              updated: [
                {
                  id: "local-n1",
                  remote_id: "note-1",
                  notebook_id: "nb-1",
                  user_id: "user-1",
                  title: "Updated",
                  content: JSON.stringify(contentObj),
                  is_trashed: false,
                  trashed_at: null,
                },
              ],
              deleted: [],
            },
            attachments: { created: [], updated: [], deleted: [] },
          },
        });
      });

      await syncDatabase(mockDb);

      expect(chains["notes"].update).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Updated",
          content: contentObj,
        }),
      );
      expect(chains["notes"].eq).toHaveBeenCalledWith("id", "note-1");
    });

    it("only pushes uploaded attachments, not pending ones", async () => {
      const chains = setupPushMocks();

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: { created: [], updated: [], deleted: [] },
            notes: { created: [], updated: [], deleted: [] },
            attachments: {
              created: [
                {
                  id: "att-local-1",
                  remote_id: "att-1",
                  note_id: "note-1",
                  user_id: "user-1",
                  file_name: "uploaded.png",
                  file_path: "path/uploaded.png",
                  file_size: 100,
                  mime_type: "image/png",
                  upload_status: "uploaded",
                },
                {
                  id: "att-local-2",
                  remote_id: "att-2",
                  note_id: "note-1",
                  user_id: "user-1",
                  file_name: "pending.png",
                  file_path: "path/pending.png",
                  file_size: 200,
                  mime_type: "image/png",
                  upload_status: "pending",
                },
              ],
              updated: [],
              deleted: [],
            },
          },
        });
      });

      await syncDatabase(mockDb);

      // Only the uploaded one should be upserted
      expect(chains["attachments"].upsert).toHaveBeenCalledWith([
        expect.objectContaining({ id: "att-1", file_name: "uploaded.png" }),
      ]);
    });

    it("skips notebook update without remote_id and logs warning", async () => {
      setupPushMocks();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: {
              created: [],
              updated: [
                { id: "local-1", remote_id: undefined, user_id: "user-1", name: "No remote" },
              ],
              deleted: [],
            },
            notes: { created: [], updated: [], deleted: [] },
            attachments: { created: [], updated: [], deleted: [] },
          },
        });
      });

      await syncDatabase(mockDb);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping notebook update with no remote_id"),
      );
      warnSpy.mockRestore();
    });

    it("skips note update without remote_id and logs warning", async () => {
      setupPushMocks();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: { created: [], updated: [], deleted: [] },
            notes: {
              created: [],
              updated: [
                {
                  id: "local-n1",
                  remote_id: undefined,
                  notebook_id: "nb-1",
                  user_id: "user-1",
                  title: "Orphan",
                  content: null,
                  is_trashed: false,
                  trashed_at: null,
                },
              ],
              deleted: [],
            },
            attachments: { created: [], updated: [], deleted: [] },
          },
        });
      });

      await syncDatabase(mockDb);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping note update with no remote_id"),
      );
      warnSpy.mockRestore();
    });

    it("pushes in order: notebooks, notes, attachments", async () => {
      const callOrder: string[] = [];

      mockSupabaseFrom.mockImplementation((table: string) => {
        callOrder.push(table);
        return mockQueryChain([]);
      });

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: {
              created: [{ id: "l1", remote_id: "nb-1", user_id: "u1", name: "NB" }],
              updated: [],
              deleted: [],
            },
            notes: {
              created: [
                {
                  id: "l2",
                  remote_id: "n-1",
                  notebook_id: "nb-1",
                  user_id: "u1",
                  title: "N",
                  content: null,
                  is_trashed: false,
                  trashed_at: null,
                },
              ],
              updated: [],
              deleted: [],
            },
            attachments: {
              created: [
                {
                  id: "l3",
                  remote_id: "a-1",
                  note_id: "n-1",
                  user_id: "u1",
                  file_name: "f.png",
                  file_path: "p",
                  file_size: 1,
                  mime_type: "image/png",
                  upload_status: "uploaded",
                },
              ],
              updated: [],
              deleted: [],
            },
          },
        });
      });

      await syncDatabase(mockDb);

      const nbIdx = callOrder.indexOf("notebooks");
      const noteIdx = callOrder.indexOf("notes");
      const attIdx = callOrder.indexOf("attachments");

      expect(nbIdx).toBeLessThan(noteIdx);
      expect(noteIdx).toBeLessThan(attIdx);
    });

    it("does not call upsert when all created attachments are pending", async () => {
      setupPushMocks();

      mockSynchronize.mockImplementation(async (opts: SynchronizeOpts) => {
        await opts.pushChanges({
          changes: {
            notebooks: { created: [], updated: [], deleted: [] },
            notes: { created: [], updated: [], deleted: [] },
            attachments: {
              created: [
                {
                  id: "att-local-1",
                  remote_id: "att-1",
                  note_id: "note-1",
                  user_id: "user-1",
                  file_name: "pending.png",
                  file_path: "path/pending.png",
                  file_size: 200,
                  mime_type: "image/png",
                  upload_status: "pending",
                },
              ],
              updated: [],
              deleted: [],
            },
          },
        });
      });

      await syncDatabase(mockDb);

      // supabase.from("attachments") should never be called since all are pending
      const attachmentCalls = mockSupabaseFrom.mock.calls.filter(
        (call: unknown[]) => call[0] === "attachments",
      );
      expect(attachmentCalls).toHaveLength(0);
    });
  });
});
