const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockEq = jest.fn();
const mockOrder = jest.fn();
const mockSingle = jest.fn();
const mockReturns = jest.fn();

function buildChain() {
  const chain: Record<string, jest.Mock> = {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    order: mockOrder,
    single: mockSingle,
    returns: mockReturns,
  };
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

import { getNotebooks, createNotebook, updateNotebook, deleteNotebook } from "@/lib/data/notebooks";
import { supabase } from "@/lib/supabase";

const mockFrom = supabase.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getNotebooks", () => {
  it("fetches all notebooks sorted by updated_at desc", async () => {
    const notebooks = [{ id: "1", name: "Work" }];
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: notebooks, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getNotebooks();

    expect(mockFrom).toHaveBeenCalledWith("notebooks");
    expect(chain.select).toHaveBeenCalledWith("*");
    expect(chain.order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toEqual(notebooks);
  });

  it("throws on error", async () => {
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: null, error: { message: "Fetch failed" } });
    mockFrom.mockReturnValue(chain);

    await expect(getNotebooks()).rejects.toEqual({ message: "Fetch failed" });
  });
});

describe("createNotebook", () => {
  it("creates a notebook with user id and name", async () => {
    const notebook = { id: "new-1", name: "Personal" };
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: notebook, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await createNotebook("user-1", "Personal");

    expect(chain.insert).toHaveBeenCalledWith({ user_id: "user-1", name: "Personal" });
    expect(result).toEqual(notebook);
  });
});

describe("updateNotebook", () => {
  it("updates notebook name", async () => {
    const chain = buildChain();
    chain.returns.mockResolvedValue({ data: { id: "1", name: "Renamed" }, error: null });
    mockFrom.mockReturnValue(chain);

    await updateNotebook("1", "Renamed");

    expect(chain.update).toHaveBeenCalledWith({ name: "Renamed" });
    expect(chain.eq).toHaveBeenCalledWith("id", "1");
  });
});

describe("deleteNotebook", () => {
  it("deletes a notebook by id", async () => {
    const chain = buildChain();
    chain.eq.mockResolvedValue({ error: null });
    mockFrom.mockReturnValue(chain);

    await deleteNotebook("1");

    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith("id", "1");
  });

  it("throws on error", async () => {
    const chain = buildChain();
    chain.eq.mockResolvedValue({ error: { message: "Delete failed" } });
    mockFrom.mockReturnValue(chain);

    await expect(deleteNotebook("1")).rejects.toEqual({ message: "Delete failed" });
  });
});
