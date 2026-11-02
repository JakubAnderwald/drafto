import { renderHook, act } from "@testing-library/react-native";

type Observer = { next: (record: { name: string }) => void; error: (err: unknown) => void };

let mockObserver: Observer | null = null;
const mockUnsubscribe = jest.fn();
const mockFindAndObserve = jest.fn((_id: string) => ({
  subscribe: (observer: Observer) => {
    mockObserver = observer;
    return { unsubscribe: mockUnsubscribe };
  },
}));

jest.mock("@/db", () => ({
  database: {
    get: () => ({ findAndObserve: (id: string) => mockFindAndObserve(id) }),
  },
}));

import { useNotebookName } from "@/hooks/use-notebook-name";

describe("useNotebookName", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserver = null;
  });

  it("is null until the notebook loads, then its name", () => {
    const { result } = renderHook(() => useNotebookName("nb-1"));
    expect(result.current).toBeNull();

    act(() => mockObserver?.next({ name: "Work" }));

    expect(mockFindAndObserve).toHaveBeenCalledWith("nb-1");
    expect(result.current).toBe("Work");
  });

  it("follows a rename even though WatermelonDB re-emits the same record object", () => {
    const record = { name: "Work" };
    const { result } = renderHook(() => useNotebookName("nb-1"));
    act(() => mockObserver?.next(record));

    record.name = "Work (2026)";
    act(() => mockObserver?.next(record));

    expect(result.current).toBe("Work (2026)");
  });

  it("is null when the notebook can't be found", () => {
    const { result } = renderHook(() => useNotebookName("missing"));

    act(() => mockObserver?.error(new Error("not found")));

    expect(result.current).toBeNull();
  });

  it("does not subscribe without an id, and unsubscribes on unmount", () => {
    renderHook(() => useNotebookName(undefined));
    expect(mockFindAndObserve).not.toHaveBeenCalled();

    const { unmount } = renderHook(() => useNotebookName("nb-1"));
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
