import { supabase } from "@/lib/supabase";
import {
  getNote,
  getNotes,
  createNote,
  updateNote,
  trashNote,
  restoreNote,
  getTrashedNotes,
  deleteNotePermanent,
} from "@/lib/data/notes";

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: jest.fn(),
  },
}));

function createChainableMock(resolvedValue: { data?: unknown; error?: unknown }) {
  const chain: Record<string, jest.Mock> = {};
  const methods = ["select", "insert", "update", "delete", "eq", "order", "single", "returns"];
  for (const m of methods) {
    chain[m] = jest.fn(() => chain);
  }
  // .returns() is always the terminal call that gets awaited
  chain.returns = jest.fn(() => Promise.resolve(resolvedValue));
  // .order() can also be terminal (e.g. getNotes chain without .returns after it — but
  // in practice it's followed by .returns). Keep it returning chain for mid-chain usage;
  // the chain is thenable so awaiting it works too.
  // Make chain itself thenable so await works on any position
  (chain as unknown as PromiseLike<typeof resolvedValue>).then = (
    resolve?: (v: typeof resolvedValue) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);

  return chain;
}

const mockFrom = supabase.from as jest.Mock;

const fakeNote = {
  id: "note-1",
  user_id: "user-1",
  notebook_id: "nb-1",
  title: "Test Note",
  content: null,
  is_trashed: false,
  trashed_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getNote", () => {
  it("returns a note by id", async () => {
    const chain = createChainableMock({ data: fakeNote, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getNote("note-1");

    expect(mockFrom).toHaveBeenCalledWith("notes");
    expect(chain.select).toHaveBeenCalledWith("*");
    expect(chain.eq).toHaveBeenCalledWith("id", "note-1");
    expect(result).toEqual(fakeNote);
  });

  it("throws on supabase error", async () => {
    const error = { message: "Not found", code: "PGRST116" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(getNote("bad-id")).rejects.toEqual(error);
  });
});

describe("getNotes", () => {
  it("returns non-trashed notes for a notebook ordered by updated_at", async () => {
    const notes = [fakeNote];
    const chain = createChainableMock({ data: notes, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getNotes("nb-1");

    expect(mockFrom).toHaveBeenCalledWith("notes");
    expect(chain.select).toHaveBeenCalledWith("*");
    expect(chain.eq).toHaveBeenCalledWith("notebook_id", "nb-1");
    expect(chain.eq).toHaveBeenCalledWith("is_trashed", false);
    expect(chain.order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toEqual(notes);
  });

  it("throws on supabase error", async () => {
    const error = { message: "DB error" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(getNotes("nb-1")).rejects.toEqual(error);
  });
});

describe("createNote", () => {
  it("inserts a note with default title when title is omitted", async () => {
    const chain = createChainableMock({ data: fakeNote, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await createNote("user-1", "nb-1");

    expect(chain.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      notebook_id: "nb-1",
      title: "Untitled",
    });
    expect(result).toEqual(fakeNote);
  });

  it("inserts a note with provided title", async () => {
    const chain = createChainableMock({ data: fakeNote, error: null });
    mockFrom.mockReturnValue(chain);

    await createNote("user-1", "nb-1", "My Note");

    expect(chain.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      notebook_id: "nb-1",
      title: "My Note",
    });
  });

  it("throws on supabase error", async () => {
    const error = { message: "Insert failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(createNote("user-1", "nb-1")).rejects.toEqual(error);
  });
});

describe("updateNote", () => {
  it("updates note fields and returns updated note", async () => {
    const updated = { ...fakeNote, title: "Updated" };
    const chain = createChainableMock({ data: updated, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await updateNote("note-1", { title: "Updated" });

    expect(chain.update).toHaveBeenCalledWith({ title: "Updated" });
    expect(chain.eq).toHaveBeenCalledWith("id", "note-1");
    expect(result).toEqual(updated);
  });

  it("throws on supabase error", async () => {
    const error = { message: "Update failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(updateNote("note-1", { title: "x" })).rejects.toEqual(error);
  });
});

describe("trashNote", () => {
  it("sets is_trashed to true with timestamp", async () => {
    const trashed = { ...fakeNote, is_trashed: true, trashed_at: "2026-01-01T00:00:00Z" };
    const chain = createChainableMock({ data: trashed, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await trashNote("note-1");

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ is_trashed: true, trashed_at: expect.any(String) }),
    );
    expect(chain.eq).toHaveBeenCalledWith("id", "note-1");
    expect(result).toEqual(trashed);
  });

  it("throws on supabase error", async () => {
    const error = { message: "Trash failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(trashNote("note-1")).rejects.toEqual(error);
  });
});

describe("restoreNote", () => {
  it("sets is_trashed to false and trashed_at to null", async () => {
    const restored = { ...fakeNote, is_trashed: false, trashed_at: null };
    const chain = createChainableMock({ data: restored, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await restoreNote("note-1");

    expect(chain.update).toHaveBeenCalledWith({ is_trashed: false, trashed_at: null });
    expect(chain.eq).toHaveBeenCalledWith("id", "note-1");
    expect(result).toEqual(restored);
  });

  it("throws on supabase error", async () => {
    const error = { message: "Restore failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(restoreNote("note-1")).rejects.toEqual(error);
  });
});

describe("getTrashedNotes", () => {
  it("returns trashed notes ordered by trashed_at", async () => {
    const trashedNotes = [{ ...fakeNote, is_trashed: true }];
    const chain = createChainableMock({ data: trashedNotes, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getTrashedNotes();

    expect(chain.select).toHaveBeenCalledWith("*");
    expect(chain.eq).toHaveBeenCalledWith("is_trashed", true);
    expect(chain.order).toHaveBeenCalledWith("trashed_at", { ascending: false });
    expect(result).toEqual(trashedNotes);
  });

  it("throws on supabase error", async () => {
    const error = { message: "Query failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(getTrashedNotes()).rejects.toEqual(error);
  });
});

describe("deleteNotePermanent", () => {
  it("deletes a note by id", async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    await deleteNotePermanent("note-1");

    expect(mockFrom).toHaveBeenCalledWith("notes");
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith("id", "note-1");
  });

  it("throws on supabase error", async () => {
    const error = { message: "Delete failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(deleteNotePermanent("note-1")).rejects.toEqual(error);
  });
});
