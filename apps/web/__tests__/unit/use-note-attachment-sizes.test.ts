import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useNoteAttachmentSizes } from "@/components/editor/use-note-attachment-sizes";

const mockFetch = vi.fn();

function respond(ok: boolean, body: unknown) {
  return { ok, json: () => Promise.resolve(body) };
}

describe("PrimeTestLab 11035 S-04 useNoteAttachmentSizes", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the note's attachments with their sizes and types", async () => {
    mockFetch.mockResolvedValue(
      respond(true, [
        { file_path: "u/n/a.pdf", file_size: 2048, mime_type: "application/pdf" },
        { nope: true },
      ]),
    );

    const { result } = renderHook(() => useNoteAttachmentSizes("note-1"));

    await waitFor(() =>
      expect(result.current.attachments).toEqual([
        { filePath: "u/n/a.pdf", fileSize: 2048, mimeType: "application/pdf" },
      ]),
    );
    expect(mockFetch).toHaveBeenCalledWith("/api/notes/note-1/attachments");
  });

  it("stays empty when the list can't be fetched", async () => {
    mockFetch.mockResolvedValue(respond(false, { error: "nope" }));
    const { result } = renderHook(() => useNoteAttachmentSizes("note-1"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(result.current.attachments).toEqual([]);
  });

  it("stays empty on a network error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useNoteAttachmentSizes("note-1"));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current.attachments).toEqual([]);
    warn.mockRestore();
  });

  it("adds an upload without fetching again, replacing an entry for the same path", async () => {
    mockFetch.mockResolvedValue(
      respond(true, [{ file_path: "u/n/a.pdf", file_size: 1, mime_type: "application/pdf" }]),
    );
    const { result } = renderHook(() => useNoteAttachmentSizes("note-1"));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    act(() => {
      result.current.addAttachment({ filePath: "u/n/b.zip", fileSize: 4096, mimeType: "x" });
      result.current.addAttachment({ filePath: "u/n/a.pdf", fileSize: 2, mimeType: "y" });
    });

    expect(result.current.attachments).toEqual([
      { filePath: "u/n/b.zip", fileSize: 4096, mimeType: "x" },
      { filePath: "u/n/a.pdf", fileSize: 2, mimeType: "y" },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("PrimeTestLab 11035 S-04 useNoteAttachmentSizes across loads", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an upload added while the list was still loading", async () => {
    let answer!: (value: unknown) => void;
    mockFetch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useNoteAttachmentSizes("note-1"));

    act(() => {
      result.current.addAttachment({ filePath: "u/n/new.pdf", fileSize: 9, mimeType: "x" });
    });
    await act(async () => {
      answer(respond(true, [{ file_path: "u/n/old.pdf", file_size: 1, mime_type: "y" }]));
    });

    expect(result.current.attachments).toEqual([
      { filePath: "u/n/old.pdf", fileSize: 1, mimeType: "y" },
      { filePath: "u/n/new.pdf", fileSize: 9, mimeType: "x" },
    ]);
  });

  it("shows nothing of the previous note while the next one loads", async () => {
    mockFetch.mockResolvedValueOnce(
      respond(true, [{ file_path: "u/n/a.pdf", file_size: 1, mime_type: "y" }]),
    );
    mockFetch.mockReturnValueOnce(new Promise(() => undefined));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useNoteAttachmentSizes(id),
      {
        initialProps: { id: "note-1" },
      },
    );
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    rerender({ id: "note-2" });

    expect(result.current.attachments).toEqual([]);
    expect(mockFetch).toHaveBeenLastCalledWith("/api/notes/note-2/attachments");
  });
});

describe("PrimeTestLab 11035 CodeRabbit useNoteAttachmentSizes stale uploads", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores an upload for the previous note that finishes after switching notes", async () => {
    mockFetch.mockResolvedValueOnce(respond(true, []));
    mockFetch.mockResolvedValueOnce(
      respond(true, [{ file_path: "u/b/b.pdf", file_size: 3, mime_type: "y" }]),
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useNoteAttachmentSizes(id),
      { initialProps: { id: "note-a" } },
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    // Note A's upload callback, captured before the switch.
    const addToNoteA = result.current.addAttachment;

    rerender({ id: "note-b" });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    act(() => {
      addToNoteA({ filePath: "u/a/late.pdf", fileSize: 9, mimeType: "x" });
    });

    expect(result.current.attachments).toEqual([
      { filePath: "u/b/b.pdf", fileSize: 3, mimeType: "y" },
    ]);
  });

  it("still adds an upload for the note on show", async () => {
    mockFetch.mockResolvedValueOnce(respond(true, []));
    mockFetch.mockResolvedValueOnce(respond(true, []));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useNoteAttachmentSizes(id),
      { initialProps: { id: "note-a" } },
    );
    rerender({ id: "note-b" });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    act(() => {
      result.current.addAttachment({ filePath: "u/b/new.pdf", fileSize: 9, mimeType: "x" });
    });

    expect(result.current.attachments).toEqual([
      { filePath: "u/b/new.pdf", fileSize: 9, mimeType: "x" },
    ]);
  });
});
