import { renderHook, act } from "@testing-library/react-native";
import { Q } from "@nozbe/watermelondb";

type Observer = { next: (count: number) => void; error: (err: unknown) => void };

let mockObserver: Observer | null = null;
const mockUnsubscribe = jest.fn();
const mockQuery = jest.fn((..._clauses: unknown[]) => ({
  observeCount: () => ({
    subscribe: (observer: Observer) => {
      mockObserver = observer;
      return { unsubscribe: mockUnsubscribe };
    },
  }),
}));
const mockGet = jest.fn((_table: string) => ({ query: mockQuery }));

jest.mock("@/db", () => ({
  database: { get: (table: string) => mockGet(table) },
}));

import { useNotebookNoteCount } from "@/hooks/use-notebook-note-count";

describe("PrimeTestLab 11035 S-03 useNotebookNoteCount", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserver = null;
  });

  it("counts the notebook's notes that are not in the trash", () => {
    renderHook(() => useNotebookNoteCount("nb-1"));

    expect(mockGet).toHaveBeenCalledWith("notes");
    expect(mockQuery).toHaveBeenCalledWith(
      Q.where("notebook_id", "nb-1"),
      Q.where("is_trashed", false),
    );
  });

  it("is null until the first count, then follows every change", () => {
    const { result } = renderHook(() => useNotebookNoteCount("nb-1"));
    expect(result.current).toBeNull();

    act(() => mockObserver?.next(3));
    expect(result.current).toBe(3);

    act(() => mockObserver?.next(2));
    expect(result.current).toBe(2);
  });

  it("is null when the count can't be read", () => {
    const { result } = renderHook(() => useNotebookNoteCount("nb-1"));
    act(() => mockObserver?.next(3));

    act(() => mockObserver?.error(new Error("db closed")));

    expect(result.current).toBeNull();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useNotebookNoteCount("nb-1"));
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
