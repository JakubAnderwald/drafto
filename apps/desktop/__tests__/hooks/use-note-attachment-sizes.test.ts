import { renderHook, act } from "@testing-library/react-native";

// Mirrored in apps/mobile/__tests__/hooks/use-note-attachment-sizes.test.ts.

type Row = { filePath: string; fileSize: number; mimeType: string };
type Observer = { next: (rows: Row[]) => void; error: (err: unknown) => void };

let mockObserver: Observer | null = null;
const mockUnsubscribe = jest.fn();
const mockQuery = jest.fn();
const mockObserveColumns = jest.fn();
const mockTable = jest.fn();

jest.mock("@nozbe/watermelondb", () => ({
  Q: { where: (column: string, value: unknown) => ({ column, value }) },
}));

jest.mock("@/db", () => ({
  database: {
    get: (table: string) => {
      mockTable(table);
      return {
        query: (...clauses: unknown[]) => {
          mockQuery(...clauses);
          return {
            observeWithColumns: (columns: string[]) => {
              mockObserveColumns(columns);
              return {
                subscribe: (observer: Observer) => {
                  mockObserver = observer;
                  return { unsubscribe: mockUnsubscribe };
                },
              };
            },
          };
        },
      };
    },
  },
}));

import { useNoteAttachmentSizes } from "@/hooks/use-note-attachment-sizes";

describe("PrimeTestLab 11035 S-04 useNoteAttachmentSizes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserver = null;
  });

  it("follows the note's attachments, including size and type changes", () => {
    const { result } = renderHook(() => useNoteAttachmentSizes("note-1"));
    expect(result.current).toEqual([]);
    expect(mockTable).toHaveBeenCalledWith("attachments");
    expect(mockQuery).toHaveBeenCalledWith({ column: "note_id", value: "note-1" });
    expect(mockObserveColumns).toHaveBeenCalledWith(["file_path", "file_size", "mime_type"]);

    act(() =>
      mockObserver?.next([{ filePath: "u/n/a.pdf", fileSize: 2048, mimeType: "application/pdf" }]),
    );

    expect(result.current).toEqual([
      { filePath: "u/n/a.pdf", fileSize: 2048, mimeType: "application/pdf" },
    ]);
  });

  it("leaves the list empty when the query fails", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderHook(() => useNoteAttachmentSizes("note-1"));

    act(() => mockObserver?.error(new Error("db closed")));

    expect(result.current).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not subscribe without a note, and unsubscribes on unmount", () => {
    renderHook(() => useNoteAttachmentSizes(undefined));
    expect(mockTable).not.toHaveBeenCalled();

    const { unmount } = renderHook(() => useNoteAttachmentSizes("note-1"));
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("drops the previous note's attachments on a note switch", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useNoteAttachmentSizes(id),
      {
        initialProps: { id: "note-1" },
      },
    );
    act(() =>
      mockObserver?.next([{ filePath: "u/n/a.pdf", fileSize: 1, mimeType: "application/pdf" }]),
    );

    rerender({ id: "note-2" });

    expect(result.current).toEqual([]);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
