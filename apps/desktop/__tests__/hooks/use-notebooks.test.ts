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
  Notebook: {},
}));

// Must import after jest.mock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useNotebooks } = require("@/hooks/use-notebooks") as typeof import("@/hooks/use-notebooks");

describe("useNotebooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("starts with loading=true and empty notebooks", () => {
    // Use a deferred observable so next is not called synchronously
    mockObserve.mockReturnValue({
      subscribe: () => ({ unsubscribe: jest.fn() }),
    });

    const { result } = renderHook(() => useNotebooks());

    expect(result.current.loading).toBe(true);
    expect(result.current.notebooks).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("sets notebooks when observable emits", async () => {
    const mockNotebooks = [
      { id: "1", name: "Work" },
      { id: "2", name: "Personal" },
    ];
    mockObserve.mockReturnValue(fakeObservable(mockNotebooks));

    const { result } = renderHook(() => useNotebooks());

    await waitFor(() => {
      expect(result.current.notebooks).toEqual(mockNotebooks);
      expect(result.current.loading).toBe(false);
    });
  });

  it("handles observable error", async () => {
    mockObserve.mockReturnValue(fakeErrorObservable(new Error("DB failure")));

    const { result } = renderHook(() => useNotebooks());

    await waitFor(() => {
      expect(result.current.error).toBe("DB failure");
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

    const { result } = renderHook(() => useNotebooks());

    await waitFor(() => {
      expect(result.current.error).toBe("Failed to load notebooks");
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

    const { unmount } = renderHook(() => useNotebooks());

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
