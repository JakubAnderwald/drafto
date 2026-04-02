import { renderHook, waitFor } from "@testing-library/react-native";
import { Q } from "@nozbe/watermelondb";

/** Minimal observable that emits a value synchronously then completes. */
function fakeObservable<T>(value: T) {
  return {
    subscribe(observer: { next: (v: T) => void; error?: (e: unknown) => void }) {
      observer.next(value);
      return { unsubscribe: jest.fn() };
    },
  };
}

/** Minimal observable that errors synchronously. */
function fakeErrorObservable(error: Error) {
  return {
    subscribe(observer: { next?: (v: unknown) => void; error: (e: unknown) => void }) {
      observer.error(error);
      return { unsubscribe: jest.fn() };
    },
  };
}

const mockObserve = jest.fn();
const mockQuery = jest.fn(() => ({ observe: mockObserve }));

jest.mock("@/db", () => ({
  get database() {
    return {
      get: () => ({ query: mockQuery }),
    };
  },
  Note: {},
}));

// Must import after jest.mock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useSearch } = require("@/hooks/use-search") as typeof import("@/hooks/use-search");

describe("useSearch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("returns empty results for blank query", () => {
    const { result } = renderHook(() => useSearch(""));
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns empty results for whitespace-only query", () => {
    const { result } = renderHook(() => useSearch("   "));
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("queries with title, content, and notebook name conditions", () => {
    renderHook(() => useSearch("hello"));

    expect(mockQuery).toHaveBeenCalled();

    const firstCall = mockQuery.mock.calls[0] as unknown as unknown[];

    // First arg is Q.experimentalJoinTables
    const joinTables = firstCall[0] as { type: string; tables: string[] };
    expect(joinTables).toEqual(Q.experimentalJoinTables(["notebooks"]));

    // Second arg is the Q.or clause with 3 conditions
    const orClause = firstCall[1] as { conditions: unknown[] };
    expect(orClause.conditions).toHaveLength(3);

    // title condition
    expect(orClause.conditions[0]).toEqual(Q.where("title", Q.like("%hello%")));

    // content condition
    expect(orClause.conditions[1]).toEqual(Q.where("content", Q.like("%hello%")));

    // notebook name condition (Q.on join)
    expect(orClause.conditions[2]).toEqual(Q.on("notebooks", "name", Q.like("%hello%")));
  });

  it("returns results from database", async () => {
    const mockNotes = [
      { id: "1", title: "Note 1" },
      { id: "2", title: "Note 2" },
    ];
    mockObserve.mockReturnValue(fakeObservable(mockNotes));

    const { result } = renderHook(() => useSearch("note"));

    await waitFor(() => {
      expect(result.current.results).toEqual(mockNotes);
      expect(result.current.loading).toBe(false);
    });
  });

  it("sets error on query failure", async () => {
    mockObserve.mockReturnValue(fakeErrorObservable(new Error("DB error")));

    const { result } = renderHook(() => useSearch("fail"));

    await waitFor(() => {
      expect(result.current.error).toBe("DB error");
      expect(result.current.loading).toBe(false);
    });
  });

  it("resets results when query becomes empty", async () => {
    const mockNotes = [{ id: "1", title: "Note 1" }];
    mockObserve.mockReturnValue(fakeObservable(mockNotes));

    const { result, rerender } = renderHook((props: { query: string }) => useSearch(props.query), {
      initialProps: { query: "test" },
    });

    await waitFor(() => {
      expect(result.current.results).toEqual(mockNotes);
    });

    rerender({ query: "" });

    await waitFor(() => {
      expect(result.current.results).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });
});
