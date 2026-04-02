import { renderHook, waitFor } from "@testing-library/react-native";

function fakeObservable<T>(value: T) {
  return {
    subscribe(observer: { next: (v: T) => void; error?: (e: unknown) => void }) {
      observer.next(value);
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useAttachments } =
  require("@/hooks/use-attachments") as typeof import("@/hooks/use-attachments");

describe("useAttachments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("returns empty attachments when no noteId", () => {
    const { result } = renderHook(() => useAttachments(undefined));

    expect(result.current.attachments).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("queries attachments for a noteId", async () => {
    const attachments = [{ id: "att-1", fileName: "photo.jpg" }];
    mockObserve.mockReturnValue(fakeObservable(attachments));

    const { result } = renderHook(() => useAttachments("note-1"));

    await waitFor(() => {
      expect(result.current.attachments).toEqual(attachments);
      expect(result.current.loading).toBe(false);
    });

    expect(mockQuery).toHaveBeenCalled();
  });

  it("resets attachments when noteId changes to undefined", async () => {
    const attachments = [{ id: "att-1" }];
    mockObserve.mockReturnValue(fakeObservable(attachments));

    const { result, rerender } = renderHook(
      (props: { id: string | undefined }) => useAttachments(props.id),
      { initialProps: { id: "note-1" as string | undefined } },
    );

    await waitFor(() => {
      expect(result.current.attachments).toEqual(attachments);
    });

    rerender({ id: undefined });

    await waitFor(() => {
      expect(result.current.attachments).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });
});
