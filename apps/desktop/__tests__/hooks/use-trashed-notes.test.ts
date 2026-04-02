import { renderHook, waitFor } from "@testing-library/react-native";

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
const { useTrashedNotes } =
  require("@/hooks/use-trashed-notes") as typeof import("@/hooks/use-trashed-notes");

describe("useTrashedNotes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("queries trashed notes on mount", async () => {
    const trashedNotes = [{ id: "1", isTrashed: true }];
    mockObserve.mockReturnValue(fakeObservable(trashedNotes));

    const { result } = renderHook(() => useTrashedNotes());

    await waitFor(() => {
      expect(result.current.notes).toEqual(trashedNotes);
      expect(result.current.loading).toBe(false);
    });

    expect(mockQuery).toHaveBeenCalled();
  });

  it("sets error on query failure", async () => {
    mockObserve.mockReturnValue(fakeErrorObservable(new Error("DB error")));

    const { result } = renderHook(() => useTrashedNotes());

    await waitFor(() => {
      expect(result.current.error).toBe("DB error");
      expect(result.current.loading).toBe(false);
    });
  });

  it("starts with loading true and empty notes", () => {
    mockObserve.mockReturnValue({
      subscribe: () => ({ unsubscribe: jest.fn() }),
    });

    const { result } = renderHook(() => useTrashedNotes());

    expect(result.current.loading).toBe(true);
    expect(result.current.notes).toEqual([]);
  });
});
