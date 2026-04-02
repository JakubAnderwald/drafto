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
const { useTrashedNotes } =
  require("@/hooks/use-trashed-notes") as typeof import("@/hooks/use-trashed-notes");

describe("useTrashedNotes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("starts with loading=true", () => {
    mockObserve.mockReturnValue({
      subscribe: () => ({ unsubscribe: jest.fn() }),
    });

    const { result } = renderHook(() => useTrashedNotes());

    expect(result.current.loading).toBe(true);
    expect(result.current.notes).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("returns trashed notes when observable emits", async () => {
    const mockNotes = [
      { id: "t1", title: "Trashed 1", is_trashed: true },
      { id: "t2", title: "Trashed 2", is_trashed: true },
    ];
    mockObserve.mockReturnValue(fakeObservable(mockNotes));

    const { result } = renderHook(() => useTrashedNotes());

    await waitFor(() => {
      expect(result.current.notes).toEqual(mockNotes);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  it("handles observable error", async () => {
    mockObserve.mockReturnValue(fakeErrorObservable(new Error("Trash query failed")));

    const { result } = renderHook(() => useTrashedNotes());

    await waitFor(() => {
      expect(result.current.error).toBe("Trash query failed");
      expect(result.current.loading).toBe(false);
    });
  });

  it("sets generic error message for non-Error throws", async () => {
    mockObserve.mockReturnValue({
      subscribe(observer: { error: (e: unknown) => void }) {
        observer.error(42);
        return { unsubscribe: jest.fn() };
      },
    });

    const { result } = renderHook(() => useTrashedNotes());

    await waitFor(() => {
      expect(result.current.error).toBe("Failed to load trashed notes");
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

    const { unmount } = renderHook(() => useTrashedNotes());

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
