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

const mockFindAndObserve = jest.fn();

jest.mock("@/db", () => ({
  get database() {
    return {
      get: () => ({ findAndObserve: mockFindAndObserve }),
    };
  },
  Note: {},
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useNote } = require("@/hooks/use-note") as typeof import("@/hooks/use-note");

describe("useNote", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns null note and stops loading when no noteId", () => {
    const { result } = renderHook(() => useNote(undefined));

    expect(result.current.note).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockFindAndObserve).not.toHaveBeenCalled();
  });

  it("observes a note by id", async () => {
    const mockNote = { id: "note-1", title: "My Note" };
    mockFindAndObserve.mockReturnValue(fakeObservable(mockNote));

    const { result } = renderHook(() => useNote("note-1"));

    await waitFor(() => {
      expect(result.current.note).toEqual(mockNote);
      expect(result.current.loading).toBe(false);
    });

    expect(mockFindAndObserve).toHaveBeenCalledWith("note-1");
  });

  it("sets error when note not found", async () => {
    mockFindAndObserve.mockReturnValue(fakeErrorObservable(new Error("Record not found")));

    const { result } = renderHook(() => useNote("missing"));

    await waitFor(() => {
      expect(result.current.error).toBe("Record not found");
      expect(result.current.loading).toBe(false);
    });
  });

  it("handles findAndObserve throwing synchronously", async () => {
    mockFindAndObserve.mockImplementation(() => {
      throw new Error("DB closed");
    });

    const { result } = renderHook(() => useNote("note-1"));

    await waitFor(() => {
      expect(result.current.error).toBe("DB closed");
      expect(result.current.loading).toBe(false);
    });
  });

  it("resets note when noteId changes to undefined", async () => {
    const mockNote = { id: "note-1" };
    mockFindAndObserve.mockReturnValue(fakeObservable(mockNote));

    const { result, rerender } = renderHook(
      (props: { id: string | undefined }) => useNote(props.id),
      { initialProps: { id: "note-1" as string | undefined } },
    );

    await waitFor(() => {
      expect(result.current.note).toEqual(mockNote);
    });

    rerender({ id: undefined });

    await waitFor(() => {
      expect(result.current.note).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });
});
