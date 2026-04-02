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

const mockFindAndObserve = jest.fn();

jest.mock("@/db", () => ({
  get database() {
    return {
      get: () => ({
        findAndObserve: mockFindAndObserve,
      }),
    };
  },
  Note: {},
}));

// Must import after jest.mock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useNote } = require("@/hooks/use-note") as typeof import("@/hooks/use-note");

describe("useNote", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindAndObserve.mockReturnValue(fakeObservable(null));
  });

  it("returns null when noteId is undefined", () => {
    const { result } = renderHook(() => useNote(undefined));

    expect(result.current.note).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockFindAndObserve).not.toHaveBeenCalled();
  });

  it("returns note when found", async () => {
    const mockNote = { id: "note-1", title: "My Note", content: "Hello" };
    mockFindAndObserve.mockReturnValue(fakeObservable(mockNote));

    const { result } = renderHook(() => useNote("note-1"));

    await waitFor(() => {
      expect(result.current.note).toEqual(mockNote);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    expect(mockFindAndObserve).toHaveBeenCalledWith("note-1");
  });

  it("handles observable error", async () => {
    mockFindAndObserve.mockReturnValue(fakeErrorObservable(new Error("Not found")));

    const { result } = renderHook(() => useNote("note-1"));

    await waitFor(() => {
      expect(result.current.error).toBe("Not found");
      expect(result.current.loading).toBe(false);
      expect(result.current.note).toBeNull();
    });
  });

  it("sets generic error message for non-Error throws", async () => {
    mockFindAndObserve.mockReturnValue({
      subscribe(observer: { error: (e: unknown) => void }) {
        observer.error("string error");
        return { unsubscribe: jest.fn() };
      },
    });

    const { result } = renderHook(() => useNote("note-1"));

    await waitFor(() => {
      expect(result.current.error).toBe("Note not found");
    });
  });

  it("handles synchronous throw from findAndObserve", async () => {
    mockFindAndObserve.mockImplementation(() => {
      throw new Error("DB crashed");
    });

    const { result } = renderHook(() => useNote("note-1"));

    await waitFor(() => {
      expect(result.current.error).toBe("DB crashed");
      expect(result.current.loading).toBe(false);
    });
  });

  it("unsubscribes on unmount", () => {
    const mockUnsubscribe = jest.fn();
    mockFindAndObserve.mockReturnValue({
      subscribe(observer: { next: (v: unknown) => void }) {
        observer.next({ id: "note-1" });
        return { unsubscribe: mockUnsubscribe };
      },
    });

    const { unmount } = renderHook(() => useNote("note-1"));

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resubscribes when noteId changes", async () => {
    const firstNote = { id: "note-1", title: "First" };
    const secondNote = { id: "note-2", title: "Second" };

    mockFindAndObserve
      .mockReturnValueOnce(fakeObservable(firstNote))
      .mockReturnValueOnce(fakeObservable(secondNote));

    const { result, rerender } = renderHook((props: { noteId: string }) => useNote(props.noteId), {
      initialProps: { noteId: "note-1" },
    });

    await waitFor(() => {
      expect(result.current.note).toEqual(firstNote);
    });

    rerender({ noteId: "note-2" });

    await waitFor(() => {
      expect(result.current.note).toEqual(secondNote);
    });
  });
});
