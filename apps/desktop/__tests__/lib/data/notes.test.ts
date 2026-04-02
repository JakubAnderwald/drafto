const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockEq = jest.fn();
const mockOrder = jest.fn();
const mockSingle = jest.fn();
const mockReturns = jest.fn();

function buildChain(overrides?: Record<string, jest.Mock>) {
  const chain: Record<string, jest.Mock> = {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    order: mockOrder,
    single: mockSingle,
    returns: mockReturns,
    ...overrides,
  };
  // Make every method return the chain (fluent API)
  for (const fn of Object.values(chain)) {
    fn.mockReturnValue(chain);
  }
  return chain;
}

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: jest.fn(),
  },
}));

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
import { supabase } from "@/lib/supabase";

const mockFrom = supabase.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getNote", () => {
  it("fetches a single note by id", async () => {
    const noteData = { id: "1", title: "Test" };
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: noteData, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getNote("1");

    expect(mockFrom).toHaveBeenCalledWith("notes");
    expect(chain.select).toHaveBeenCalledWith("*");
    expect(chain.eq).toHaveBeenCalledWith("id", "1");
    expect(chain.single).toHaveBeenCalled();
    expect(result).toEqual(noteData);
  });

  it("throws on error", async () => {
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: null, error: { message: "Not found" } });
    mockFrom.mockReturnValue(chain);

    await expect(getNote("missing")).rejects.toEqual({ message: "Not found" });
  });
});

describe("getNotes", () => {
  it("fetches notes for a notebook, excluding trashed", async () => {
    const notes = [{ id: "1" }, { id: "2" }];
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: notes, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getNotes("nb-1");

    expect(chain.eq).toHaveBeenCalledWith("notebook_id", "nb-1");
    expect(chain.eq).toHaveBeenCalledWith("is_trashed", false);
    expect(chain.order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toEqual(notes);
  });
});

describe("createNote", () => {
  it("creates a note with default title", async () => {
    const noteData = { id: "new-1", title: "Untitled" };
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: noteData, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await createNote("user-1", "nb-1");

    expect(chain.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      notebook_id: "nb-1",
      title: "Untitled",
    });
    expect(result).toEqual(noteData);
  });

  it("creates a note with custom title", async () => {
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: { id: "new-1", title: "My Note" }, error: null });
    mockFrom.mockReturnValue(chain);

    await createNote("user-1", "nb-1", "My Note");

    expect(chain.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      notebook_id: "nb-1",
      title: "My Note",
    });
  });
});

describe("updateNote", () => {
  it("updates note fields", async () => {
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: { id: "1", title: "Updated" }, error: null });
    mockFrom.mockReturnValue(chain);

    await updateNote("1", { title: "Updated" });

    expect(chain.update).toHaveBeenCalledWith({ title: "Updated" });
    expect(chain.eq).toHaveBeenCalledWith("id", "1");
  });
});

describe("trashNote", () => {
  it("sets is_trashed to true with timestamp", async () => {
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: { id: "1", is_trashed: true }, error: null });
    mockFrom.mockReturnValue(chain);

    await trashNote("1");

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ is_trashed: true, trashed_at: expect.any(String) }),
    );
  });
});

describe("restoreNote", () => {
  it("sets is_trashed to false and clears trashed_at", async () => {
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: { id: "1", is_trashed: false }, error: null });
    mockFrom.mockReturnValue(chain);

    await restoreNote("1");

    expect(chain.update).toHaveBeenCalledWith({ is_trashed: false, trashed_at: null });
  });
});

describe("getTrashedNotes", () => {
  it("fetches trashed notes sorted by trashed_at desc", async () => {
    const notes = [{ id: "1", is_trashed: true }];
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: notes, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getTrashedNotes();

    expect(chain.eq).toHaveBeenCalledWith("is_trashed", true);
    expect(chain.order).toHaveBeenCalledWith("trashed_at", { ascending: false });
    expect(result).toEqual(notes);
  });
});

describe("deleteNotePermanent", () => {
  it("deletes a note by id", async () => {
    const chain = buildChain();
    chain.eq.mockResolvedValue({ error: null });
    mockFrom.mockReturnValue(chain);

    await deleteNotePermanent("1");

    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith("id", "1");
  });

  it("throws on error", async () => {
    const chain = buildChain();
    chain.eq.mockResolvedValue({ error: { message: "Delete failed" } });
    mockFrom.mockReturnValue(chain);

    await expect(deleteNotePermanent("1")).rejects.toEqual({ message: "Delete failed" });
  });
});
