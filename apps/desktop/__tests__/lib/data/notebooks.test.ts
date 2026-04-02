import { supabase } from "@/lib/supabase";
import { getNotebooks, createNotebook, updateNotebook, deleteNotebook } from "@/lib/data/notebooks";

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
  // .returns() is the terminal call that gets awaited
  chain.returns = jest.fn(() => Promise.resolve(resolvedValue));
  // Make chain thenable so await works at any position (e.g. delete().eq())
  (chain as unknown as PromiseLike<typeof resolvedValue>).then = (
    resolve?: (v: typeof resolvedValue) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);

  return chain;
}

const mockFrom = supabase.from as jest.Mock;

const fakeNotebook = {
  id: "nb-1",
  user_id: "user-1",
  name: "My Notebook",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getNotebooks", () => {
  it("returns notebooks ordered by updated_at", async () => {
    const notebooks = [fakeNotebook];
    const chain = createChainableMock({ data: notebooks, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getNotebooks();

    expect(mockFrom).toHaveBeenCalledWith("notebooks");
    expect(chain.select).toHaveBeenCalledWith("*");
    expect(chain.order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toEqual(notebooks);
  });

  it("throws on supabase error", async () => {
    const error = { message: "Query failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(getNotebooks()).rejects.toEqual(error);
  });
});

describe("createNotebook", () => {
  it("inserts a notebook and returns it", async () => {
    const chain = createChainableMock({ data: fakeNotebook, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await createNotebook("user-1", "My Notebook");

    expect(mockFrom).toHaveBeenCalledWith("notebooks");
    expect(chain.insert).toHaveBeenCalledWith({ user_id: "user-1", name: "My Notebook" });
    expect(chain.select).toHaveBeenCalled();
    expect(chain.single).toHaveBeenCalled();
    expect(result).toEqual(fakeNotebook);
  });

  it("throws on supabase error", async () => {
    const error = { message: "Insert failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(createNotebook("user-1", "Notebook")).rejects.toEqual(error);
  });
});

describe("updateNotebook", () => {
  it("updates the notebook name and returns it", async () => {
    const updated = { ...fakeNotebook, name: "Renamed" };
    const chain = createChainableMock({ data: updated, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await updateNotebook("nb-1", "Renamed");

    expect(mockFrom).toHaveBeenCalledWith("notebooks");
    expect(chain.update).toHaveBeenCalledWith({ name: "Renamed" });
    expect(chain.eq).toHaveBeenCalledWith("id", "nb-1");
    expect(chain.single).toHaveBeenCalled();
    expect(result).toEqual(updated);
  });

  it("throws on supabase error", async () => {
    const error = { message: "Update failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(updateNotebook("nb-1", "x")).rejects.toEqual(error);
  });
});

describe("deleteNotebook", () => {
  it("deletes a notebook by id", async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    await deleteNotebook("nb-1");

    expect(mockFrom).toHaveBeenCalledWith("notebooks");
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith("id", "nb-1");
  });

  it("throws on supabase error", async () => {
    const error = { message: "Delete failed" };
    const chain = createChainableMock({ data: null, error });
    mockFrom.mockReturnValue(chain);

    await expect(deleteNotebook("nb-1")).rejects.toEqual(error);
  });
});
