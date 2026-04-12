import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const {
  listNotebooks,
  listNotes,
  readNote,
  searchNotes,
  createNotebook,
  createNote,
  updateNote,
  moveNote,
  trashNote,
} = await import("@/lib/api/mcp-tools");

type MockFn = ReturnType<typeof vi.fn>;

function createMockSupabase(fromImpl: MockFn, rpcImpl?: MockFn) {
  return {
    from: fromImpl,
    rpc: rpcImpl ?? vi.fn(),
  } as never;
}

function chainOk(data: unknown) {
  return {
    select: () => ({
      eq: () => ({
        order: () => Promise.resolve({ data, error: null }),
        eq: () => ({
          order: () => Promise.resolve({ data, error: null }),
          eq: () => ({
            order: () => Promise.resolve({ data, error: null }),
            single: () => Promise.resolve({ data, error: null }),
          }),
          single: () => Promise.resolve({ data, error: null }),
        }),
        single: () => Promise.resolve({ data, error: null }),
      }),
    }),
    insert: () => ({
      select: () => ({
        single: () => Promise.resolve({ data, error: null }),
      }),
    }),
    update: () => ({
      eq: () => ({
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data, error: null }),
          }),
        }),
        select: () => ({
          single: () => Promise.resolve({ data, error: null }),
        }),
      }),
    }),
  };
}

function chainErr(message: string) {
  return {
    select: () => ({
      eq: () => ({
        order: () => Promise.resolve({ data: null, error: { message } }),
        eq: () => ({
          order: () => Promise.resolve({ data: null, error: { message } }),
          eq: () => ({
            order: () => Promise.resolve({ data: null, error: { message } }),
          }),
        }),
        single: () => Promise.resolve({ data: null, error: { message } }),
      }),
    }),
    insert: () => ({
      select: () => ({
        single: () => Promise.resolve({ data: null, error: { message } }),
      }),
    }),
    update: () => ({
      eq: () => ({
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: null, error: { message } }),
          }),
        }),
      }),
    }),
  };
}

describe("listNotebooks", () => {
  it("returns notebooks on success", async () => {
    const notebooks = [{ id: "nb-1", name: "Notes" }];
    const supabase = createMockSupabase(vi.fn(() => chainOk(notebooks)));

    const result = await listNotebooks(supabase, "user-1");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(notebooks);
  });

  it("returns error on failure", async () => {
    const supabase = createMockSupabase(vi.fn(() => chainErr("Query failed")));

    const result = await listNotebooks(supabase, "user-1");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Query failed");
  });
});

describe("listNotes", () => {
  it("returns notes on success", async () => {
    const notes = [{ id: "note-1", title: "Test" }];
    const supabase = createMockSupabase(vi.fn(() => chainOk(notes)));

    const result = await listNotes(supabase, "user-1", "nb-1");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(notes);
  });
});

describe("readNote", () => {
  it("returns note content as markdown", async () => {
    const note = {
      id: "note-1",
      title: "Test Note",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello", styles: {} }], children: [] },
      ],
      notebook_id: "nb-1",
      is_trashed: false,
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
    };
    const notebook = { name: "My Notebook" };

    const mockFrom = vi.fn((table: string) => {
      if (table === "notes") return chainOk(note);
      if (table === "notebooks") return chainOk(notebook);
      return chainOk(null);
    });

    const result = await readNote(createMockSupabase(mockFrom), "user-1", "note-1");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("# Test Note");
    expect(result.content[0].text).toContain("Hello");
    expect(result.content[0].text).toContain("My Notebook");
  });

  it("returns error when note not found", async () => {
    const supabase = createMockSupabase(
      vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "Not found" } }),
            }),
          }),
        }),
      })),
    );

    const result = await readNote(supabase, "user-1", "bad-id");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Note not found");
  });
});

describe("searchNotes", () => {
  it("returns search results on success", async () => {
    const results = [{ id: "note-1", title: "Match" }];
    const supabase = createMockSupabase(
      vi.fn(() => ({
        select: () => ({
          eq: () => ({
            ilike: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: results, error: null }),
              }),
            }),
          }),
        }),
      })),
    );

    const result = await searchNotes(supabase, "user-1", "test");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(results);
  });

  it("returns error on query failure", async () => {
    const supabase = createMockSupabase(
      vi.fn(() => ({
        select: () => ({
          eq: () => ({
            ilike: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: null, error: { message: "Query error" } }),
              }),
            }),
          }),
        }),
      })),
    );

    const result = await searchNotes(supabase, "user-1", "test");
    expect(result.isError).toBe(true);
  });
});

describe("createNotebook", () => {
  it("creates notebook successfully", async () => {
    const nb = { id: "nb-new", name: "New" };
    const supabase = createMockSupabase(vi.fn(() => chainOk(nb)));

    const result = await createNotebook(supabase, "user-1", "New");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(nb);
  });
});

describe("createNote", () => {
  it("creates note with markdown content", async () => {
    const noteData = { id: "note-new", title: "Hello" };
    const supabase = createMockSupabase(vi.fn(() => chainOk(noteData)));

    const result = await createNote(supabase, "user-1", "nb-1", "Hello", "# Content");
    expect(result.isError).toBeUndefined();
  });

  it("creates note without content", async () => {
    const noteData = { id: "note-new", title: "Hello" };
    const supabase = createMockSupabase(vi.fn(() => chainOk(noteData)));

    const result = await createNote(supabase, "user-1", "nb-1", "Hello");
    expect(result.isError).toBeUndefined();
  });

  it("returns error when notebook not found", async () => {
    const supabase = createMockSupabase(
      vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "not found" } }),
            }),
          }),
        }),
      })),
    );

    const result = await createNote(supabase, "user-1", "bad-nb", "Title");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Notebook not found");
  });
});

describe("updateNote", () => {
  it("updates title successfully", async () => {
    const updated = { id: "note-1", title: "New Title", updated_at: "2026-01-02" };
    const supabase = createMockSupabase(vi.fn(() => chainOk(updated)));

    const result = await updateNote(supabase, "user-1", "note-1", "New Title");
    expect(result.isError).toBeUndefined();
  });

  it("updates content with markdown", async () => {
    const updated = { id: "note-1", title: "Title", updated_at: "2026-01-02" };
    const supabase = createMockSupabase(vi.fn(() => chainOk(updated)));

    const result = await updateNote(supabase, "user-1", "note-1", undefined, "# New content");
    expect(result.isError).toBeUndefined();
  });

  it("returns error when no fields provided", async () => {
    const supabase = createMockSupabase(vi.fn());

    const result = await updateNote(supabase, "user-1", "note-1");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No fields to update");
  });
});

describe("moveNote", () => {
  it("moves note successfully", async () => {
    const moved = { id: "note-1", title: "Test", notebook_id: "nb-2" };
    const supabase = createMockSupabase(vi.fn(() => chainOk(moved)));

    const result = await moveNote(supabase, "user-1", "note-1", "nb-2");
    expect(result.isError).toBeUndefined();
  });

  it("returns error when target notebook not found", async () => {
    const supabase = createMockSupabase(
      vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "not found" } }),
            }),
          }),
        }),
      })),
    );

    const result = await moveNote(supabase, "user-1", "note-1", "bad-nb");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Target notebook not found");
  });
});

describe("trashNote", () => {
  it("trashes note successfully", async () => {
    const trashed = { id: "note-1", title: "Test" };
    const supabase = createMockSupabase(vi.fn(() => chainOk(trashed)));

    const result = await trashNote(supabase, "user-1", "note-1");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("moved to trash");
  });
});
