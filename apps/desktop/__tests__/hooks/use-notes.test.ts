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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useNotes } = require("@/hooks/use-notes") as typeof import("@/hooks/use-notes");

describe("useNotes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("returns empty notes and stops loading when no notebookId", () => {
    const { result } = renderHook(() => useNotes(undefined));

    expect(result.current.notes).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("queries notes for a notebookId", async () => {
    const mockNotes = [{ id: "1", title: "Note 1" }];
    mockObserve.mockReturnValue(fakeObservable(mockNotes));

    const { result } = renderHook(() => useNotes("nb-1"));

    await waitFor(() => {
      expect(result.current.notes).toEqual(mockNotes);
      expect(result.current.loading).toBe(false);
    });

    expect(mockQuery).toHaveBeenCalled();
  });

  it("sets error on query failure", async () => {
    mockObserve.mockReturnValue(fakeErrorObservable(new Error("Query failed")));

    const { result } = renderHook(() => useNotes("nb-1"));

    await waitFor(() => {
      expect(result.current.error).toBe("Query failed");
      expect(result.current.loading).toBe(false);
    });
  });

  it("resets notes when notebookId changes to undefined", async () => {
    const mockNotes = [{ id: "1" }];
    mockObserve.mockReturnValue(fakeObservable(mockNotes));

    const { result, rerender } = renderHook(
      (props: { id: string | undefined }) => useNotes(props.id),
      { initialProps: { id: "nb-1" as string | undefined } },
    );

    await waitFor(() => {
      expect(result.current.notes).toEqual(mockNotes);
    });

    rerender({ id: undefined });

    await waitFor(() => {
      expect(result.current.notes).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });
});
