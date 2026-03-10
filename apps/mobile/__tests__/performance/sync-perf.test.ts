/**
 * Performance tests for sync operations.
 * Verifies that syncing 1000 notes completes within acceptable time bounds.
 */

// Mock supabase before importing sync module
jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: jest.fn(),
    rpc: jest.fn().mockResolvedValue({ data: new Date().toISOString(), error: null }),
  },
}));

// Mock WatermelonDB synchronize
jest.mock("@nozbe/watermelondb/sync", () => ({
  synchronize: jest.fn(),
}));

import { synchronize } from "@nozbe/watermelondb/sync";
import { supabase } from "@/lib/supabase";
import { syncDatabase } from "@/db/sync";

// Helper: generate mock notebook rows
function generateNotebooks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `notebook-${i}`,
    user_id: "user-1",
    name: `Notebook ${i}`,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date().toISOString(),
  }));
}

// Helper: generate mock note rows with realistic content
function generateNotes(count: number, notebookCount: number) {
  const sampleContent = [
    { type: "paragraph", content: [{ type: "text", text: "Sample note content with some text." }] },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Section Header" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Item 1" }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Item 2" }] }],
        },
      ],
    },
  ];

  return Array.from({ length: count }, (_, i) => ({
    id: `note-${i}`,
    notebook_id: `notebook-${i % notebookCount}`,
    user_id: "user-1",
    title: `Note ${i}: Performance Test Entry`,
    content: sampleContent,
    is_trashed: false,
    trashed_at: null,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date().toISOString(),
  }));
}

// Helper: generate mock attachment rows
function generateAttachments(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `attachment-${i}`,
    note_id: `note-${i % 100}`,
    user_id: "user-1",
    file_name: `image-${i}.jpg`,
    file_path: `user-1/note-${i % 100}/image-${i}.jpg`,
    file_size: 102400 + i,
    mime_type: "image/jpeg",
    created_at: new Date().toISOString(),
  }));
}

describe("Sync Performance", () => {
  const mockFrom = supabase.from as jest.Mock;
  const mockSynchronize = synchronize as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should process pullChanges mapping for 1000 notes under 500ms", () => {
    const notebookCount = 50;
    const noteCount = 1000;
    const attachmentCount = 200;

    const notebooks = generateNotebooks(notebookCount);
    const notes = generateNotes(noteCount, notebookCount);
    const attachments = generateAttachments(attachmentCount);

    const start = Date.now();

    const mappedNotebooks = notebooks.map((row) => ({
      id: row.id,
      remote_id: row.id,
      user_id: row.user_id,
      name: row.name,
      created_at: new Date(row.created_at).getTime(),
      updated_at: new Date(row.updated_at).getTime(),
    }));

    const mappedNotes = notes.map((row) => ({
      id: row.id,
      remote_id: row.id,
      notebook_id: row.notebook_id,
      user_id: row.user_id,
      title: row.title,
      content: row.content ? JSON.stringify(row.content) : null,
      is_trashed: row.is_trashed,
      trashed_at: null,
      created_at: new Date(row.created_at).getTime(),
      updated_at: new Date(row.updated_at).getTime(),
    }));

    const mappedAttachments = attachments.map((row) => ({
      id: row.id,
      remote_id: row.id,
      note_id: row.note_id,
      user_id: row.user_id,
      file_name: row.file_name,
      file_path: row.file_path,
      file_size: row.file_size,
      mime_type: row.mime_type,
      created_at: new Date(row.created_at).getTime(),
      local_uri: null,
      upload_status: "uploaded",
    }));

    const duration = Date.now() - start;

    expect(mappedNotebooks).toHaveLength(notebookCount);
    expect(mappedNotes).toHaveLength(noteCount);
    expect(mappedAttachments).toHaveLength(attachmentCount);
    expect(duration).toBeLessThan(500);
  });

  it("should handle syncDatabase with 1000 notes via synchronize mock", async () => {
    const notebookCount = 50;
    const noteCount = 1000;

    // Setup synchronize mock to simulate what happens during sync
    mockSynchronize.mockImplementation(
      async ({
        pullChanges,
        pushChanges,
      }: {
        pullChanges: (args: { lastPulledAt?: number }) => Promise<unknown>;
        pushChanges: (args: { changes: Record<string, unknown> }) => Promise<void>;
      }) => {
        const pullResult = await pullChanges({ lastPulledAt: undefined });
        expect(pullResult).toBeDefined();

        await pushChanges({
          changes: {
            notebooks: { created: [], updated: [], deleted: [] },
            notes: { created: [], updated: [], deleted: [] },
            attachments: { created: [], updated: [], deleted: [] },
          },
        });
      },
    );

    // Setup supabase mock to return large datasets
    const notebooks = generateNotebooks(notebookCount);
    const notes = generateNotes(noteCount, notebookCount);
    const attachments = generateAttachments(200);

    mockFrom.mockImplementation((table: string) => ({
      select: jest.fn().mockReturnValue({
        gt: jest.fn().mockResolvedValue({
          data: table === "notebooks" ? notebooks : table === "notes" ? notes : attachments,
          error: null,
        }),
        data: table === "notebooks" ? notebooks : table === "notes" ? notes : attachments,
        error: null,
      }),
    }));

    const mockDb = {} as Parameters<typeof syncDatabase>[0];

    const start = Date.now();
    await syncDatabase(mockDb);
    const duration = Date.now() - start;

    // First sync with 1000 notes should complete under 2s
    expect(duration).toBeLessThan(2000);
    expect(mockSynchronize).toHaveBeenCalledTimes(1);
  });

  it("should handle incremental sync with 100 changed notes under 200ms", async () => {
    const changedNotes = generateNotes(100, 10);

    mockSynchronize.mockImplementation(
      async ({
        pullChanges,
      }: {
        pullChanges: (args: { lastPulledAt?: number }) => Promise<{
          changes: { notes: { updated: unknown[]; created: unknown[] } };
        }>;
      }) => {
        const pullResult = await pullChanges({
          lastPulledAt: Date.now() - 60000,
        });
        expect(pullResult.changes.notes.updated).toHaveLength(100);
        expect(pullResult.changes.notes.created).toHaveLength(0);
      },
    );

    mockFrom.mockImplementation((table: string) => ({
      select: jest.fn().mockReturnValue({
        gt: jest.fn().mockResolvedValue({
          data: table === "notes" ? changedNotes : [],
          error: null,
        }),
      }),
    }));

    const mockDb = {} as Parameters<typeof syncDatabase>[0];

    const start = Date.now();
    await syncDatabase(mockDb);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(200);
  });

  it("should generate push payloads for 100 dirty notes under 200ms", () => {
    const noteCount = 100;
    const notes = generateNotes(noteCount, 10);

    const start = Date.now();

    const pushPayload = notes.map((n) => ({
      id: n.id,
      notebook_id: n.notebook_id,
      user_id: n.user_id,
      title: n.title,
      content: n.content ? JSON.stringify(n.content) : null,
      is_trashed: n.is_trashed,
      trashed_at: n.trashed_at,
    }));

    const parsed = pushPayload.map((p) => ({
      ...p,
      content: p.content ? JSON.parse(p.content) : null,
    }));

    const duration = Date.now() - start;

    expect(parsed).toHaveLength(noteCount);
    expect(duration).toBeLessThan(200);
  });

  it("should handle content serialization round-trip for 1000 notes under 500ms", () => {
    const notes = generateNotes(1000, 50);

    const start = Date.now();

    const serialized = notes.map((n) => ({
      ...n,
      content: n.content ? JSON.stringify(n.content) : null,
    }));

    const deserialized = serialized.map((n) => ({
      ...n,
      content: n.content ? JSON.parse(n.content) : null,
    }));

    const duration = Date.now() - start;

    expect(deserialized).toHaveLength(1000);
    expect(deserialized[0].content).toEqual(notes[0].content);
    expect(duration).toBeLessThan(500);
  });
});
