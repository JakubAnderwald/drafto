import { renderHook, waitFor } from "@testing-library/react-native";

/** Minimal observable that emits a value synchronously. */
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
const { useNotes } = require("@/hooks/use-notes") as typeof import("@/hooks/use-notes");

describe("useNotes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("returns empty notes when notebookId is undefined", () => {
    const { result } = renderHook(() => useNotes(undefined));

    expect(result.current.notes).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("subscribes and returns notes when notebookId is provided", async () => {
    const mockNotes = [
      { id: "n1", title: "Note 1" },
      { id: "n2", title: "Note 2" },
    ];
    mockObserve.mockReturnValue(fakeObservable(mockNotes));

    const { result } = renderHook(() => useNotes("notebook-1"));

    await waitFor(() => {
      expect(result.current.notes).toEqual(mockNotes);
      expect(result.current.loading).toBe(false);
    });

    expect(mockQuery).toHaveBeenCalled();
  });

  it("handles observable error", async () => {
    mockObserve.mockReturnValue(fakeErrorObservable(new Error("Query failed")));

    const { result } = renderHook(() => useNotes("notebook-1"));

    await waitFor(() => {
      expect(result.current.error).toBe("Query failed");
      expect(result.current.loading).toBe(false);
    });
  });

  it("sets generic error message for non-Error throws", async () => {
    mockObserve.mockReturnValue({
      subscribe(observer: { error: (e: unknown) => void }) {
        observer.error("string error");
        return { unsubscribe: jest.fn() };
      },
    });

    const { result } = renderHook(() => useNotes("notebook-1"));

    await waitFor(() => {
      expect(result.current.error).toBe("Failed to load notes");
    });
  });

  it("unsubscribes on unmount", () => {
    const mockUnsubscribe = jest.fn();
    mockObserve.mockReturnValue({
      subscribe(observer: { next: (v: unknown[]) => void }) {
        observer.next([]);
        return { unsubscribe: mockUnsubscribe };
      },
    });

    const { unmount } = renderHook(() => useNotes("notebook-1"));

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resubscribes when notebookId changes", async () => {
    const firstNotes = [{ id: "n1", title: "First" }];
    const secondNotes = [{ id: "n2", title: "Second" }];

    mockObserve.mockReturnValueOnce(fakeObservable(firstNotes));
    mockObserve.mockReturnValueOnce(fakeObservable(secondNotes));

    const { result, rerender } = renderHook(
      (props: { notebookId: string }) => useNotes(props.notebookId),
      { initialProps: { notebookId: "nb-1" } },
    );

    await waitFor(() => {
      expect(result.current.notes).toEqual(firstNotes);
    });

    rerender({ notebookId: "nb-2" });

    await waitFor(() => {
      expect(result.current.notes).toEqual(secondNotes);
    });
  });
});
