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
  Attachment: {},
}));

// Must import after jest.mock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useAttachments } =
  require("@/hooks/use-attachments") as typeof import("@/hooks/use-attachments");

describe("useAttachments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("returns empty attachments when noteId is undefined", () => {
    const { result } = renderHook(() => useAttachments(undefined));

    expect(result.current.attachments).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns attachments when noteId is provided", async () => {
    const mockAttachments = [
      { id: "a1", file_name: "image.png", mime_type: "image/png" },
      { id: "a2", file_name: "doc.pdf", mime_type: "application/pdf" },
    ];
    mockObserve.mockReturnValue(fakeObservable(mockAttachments));

    const { result } = renderHook(() => useAttachments("note-1"));

    await waitFor(() => {
      expect(result.current.attachments).toEqual(mockAttachments);
      expect(result.current.loading).toBe(false);
    });

    expect(mockQuery).toHaveBeenCalled();
  });

  it("handles observable error gracefully", async () => {
    mockObserve.mockReturnValue(fakeErrorObservable(new Error("Attachment load failed")));

    const { result } = renderHook(() => useAttachments("note-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      // useAttachments does not expose error state, just stops loading
      expect(result.current.attachments).toEqual([]);
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

    const { unmount } = renderHook(() => useAttachments("note-1"));

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resubscribes when noteId changes", async () => {
    const firstAttachments = [{ id: "a1", file_name: "first.png" }];
    const secondAttachments = [{ id: "a2", file_name: "second.png" }];

    mockObserve
      .mockReturnValueOnce(fakeObservable(firstAttachments))
      .mockReturnValueOnce(fakeObservable(secondAttachments));

    const { result, rerender } = renderHook(
      (props: { noteId: string | undefined }) => useAttachments(props.noteId),
      { initialProps: { noteId: "note-1" as string | undefined } },
    );

    await waitFor(() => {
      expect(result.current.attachments).toEqual(firstAttachments);
    });

    rerender({ noteId: "note-2" });

    await waitFor(() => {
      expect(result.current.attachments).toEqual(secondAttachments);
    });
  });

  it("clears attachments when noteId becomes undefined", async () => {
    const mockAttachments = [{ id: "a1", file_name: "image.png" }];
    mockObserve.mockReturnValue(fakeObservable(mockAttachments));

    const { result, rerender } = renderHook(
      (props: { noteId: string | undefined }) => useAttachments(props.noteId),
      { initialProps: { noteId: "note-1" as string | undefined } },
    );

    await waitFor(() => {
      expect(result.current.attachments).toEqual(mockAttachments);
    });

    rerender({ noteId: undefined });

    await waitFor(() => {
      expect(result.current.attachments).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });
});
