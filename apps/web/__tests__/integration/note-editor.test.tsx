import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  STORAGE_QUOTA_EXCEEDED_CODE,
  STORAGE_QUOTA_EXCEEDED_MESSAGE,
  storageFullMessage,
} from "@drafto/shared";

// Mock BlockNote dependencies — they require a real DOM canvas, which jsdom lacks
let capturedUploadFile: ((file: File, blockId?: string) => Promise<string>) | undefined;
// The editor stub useCreateBlockNote returns: the storage-full path removes the
// placeholder block through it.
const mockGetBlock = vi.fn();
const mockRemoveBlocks = vi.fn();
let capturedResolveFileUrl: ((url: string) => Promise<string>) | undefined;

// Mock the extracted hook — returns a resolver that delegates to fetch
const ATTACHMENT_PREFIX = "attachment://";
vi.mock("@/components/editor/use-attachment-url-resolver", () => ({
  useAttachmentUrlResolver: () => {
    const resolver = async (url: string): Promise<string> => {
      if (!url.startsWith(ATTACHMENT_PREFIX)) return url;
      const filePath = url.slice(ATTACHMENT_PREFIX.length);
      const response = await fetch("/api/attachments/resolve-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
      if (!response.ok) throw new Error("Failed to resolve attachment URL");
      const data = await response.json();
      return data.signedUrl;
    };
    capturedResolveFileUrl = resolver;
    return resolver;
  },
}));

vi.mock("@blocknote/react", () => ({
  useCreateBlockNote: (opts?: {
    uploadFile?: (file: File, blockId?: string) => Promise<string>;
    resolveFileUrl?: (url: string) => Promise<string>;
  }) => {
    capturedUploadFile = opts?.uploadFile;
    return { document: [], getBlock: mockGetBlock, removeBlocks: mockRemoveBlocks };
  },
  BlockNoteView: vi.fn(({ editor: _editor, theme: _theme }) => (
    <div data-testid="blocknote-editor">BlockNote Editor</div>
  )),
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: vi.fn(({ editor: _editor, theme: _theme }) => (
    <div data-testid="blocknote-editor">BlockNote Editor</div>
  )),
}));

vi.mock("@blocknote/mantine/style.css", () => ({}));

const mockUploadToSignedUrl = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        uploadToSignedUrl: mockUploadToSignedUrl,
      }),
    },
  }),
}));

const mockSetTheme = vi.fn();
vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({
    theme: "light" as const,
    resolvedTheme: "light" as const,
    setTheme: mockSetTheme,
  }),
}));

const mockFetch = vi.fn();

const { NoteEditor } = await import("@/components/editor/note-editor");

describe("NoteEditor", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    mockUploadToSignedUrl.mockReset();
    mockGetBlock.mockReset();
    mockRemoveBlocks.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("renders without crashing", async () => {
    await act(async () => {
      render(<NoteEditor noteId="note-1" />);
    });

    expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
  });

  it("renders with initial content", async () => {
    const initialContent = [
      {
        id: "block-1",
        type: "paragraph",
        content: [{ type: "text", text: "Hello", styles: {} }],
        props: {},
        children: [],
      },
    ];

    await act(async () => {
      render(
        <NoteEditor
          noteId="note-1"
          initialContent={
            initialContent as unknown as Parameters<typeof NoteEditor>[0]["initialContent"]
          }
        />,
      );
    });

    expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
  });

  it("accepts an onChange callback", async () => {
    const onChange = vi.fn();

    await act(async () => {
      render(<NoteEditor noteId="note-1" onChange={onChange} />);
    });

    // The editor renders — onChange is passed through to BlockNoteView
    expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
  });

  it("passes resolved theme to BlockNoteView for dynamic light/dark mode", async () => {
    const { BlockNoteView } = await import("@blocknote/mantine");
    const mockBlockNoteView = vi.mocked(BlockNoteView);
    mockBlockNoteView.mockClear();

    await act(async () => {
      render(<NoteEditor noteId="note-1" />);
    });

    expect(mockBlockNoteView).toHaveBeenCalled();

    const props = mockBlockNoteView.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props?.theme).toBe("light");
  });

  it("wraps the editor in a scrollable container", async () => {
    await act(async () => {
      render(<NoteEditor noteId="note-1" />);
    });

    const container = screen.getByTestId("blocknote-editor").parentElement;
    expect(container).toHaveAttribute("data-testid", "editor-scroll-container");
  });

  it("provides uploadFile handler that uses three-step direct upload flow", async () => {
    // Step 1: upload-url returns signed URL and token
    // Step 2: uploadToSignedUrl (mocked via supabase client)
    // Step 3: confirm returns attachment record
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            signedUrl: "https://storage.supabase.co/upload/sign/path?token=xyz",
            token: "upload-token",
            filePath: "user-1/note-42/image-12345.png",
            fileName: "image-12345.png",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "att-1",
            file_name: "image-12345.png",
            file_path: "user-1/note-42/image-12345.png",
            url: "https://example.com/signed-url",
          }),
      });

    mockUploadToSignedUrl.mockResolvedValue({ error: null });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    expect(capturedUploadFile).toBeDefined();
    const file = new File(["test"], "image.png", { type: "image/png" });
    const url = await capturedUploadFile!(file);

    expect(url).toBe("attachment://user-1/note-42/image-12345.png");
    // Step 1: request signed upload URL
    expect(mockFetch).toHaveBeenCalledWith("/api/notes/note-42/attachments/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "image.png",
        fileSize: 4,
        mimeType: "image/png",
      }),
    });
    // Step 2: direct upload to Supabase
    expect(mockUploadToSignedUrl).toHaveBeenCalledWith(
      "user-1/note-42/image-12345.png",
      "upload-token",
      file,
      { contentType: "image/png" },
    );
    // Step 3: confirm upload
    expect(mockFetch).toHaveBeenCalledWith("/api/notes/note-42/attachments/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: "user-1/note-42/image-12345.png",
        fileSize: 4,
        mimeType: "image/png",
      }),
    });
  });

  it("throws when upload-url API returns an error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "File size exceeds 50MB limit" }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["test"], "large.bin", { type: "application/octet-stream" });
    await expect(capturedUploadFile!(file)).rejects.toThrow("File size exceeds 50MB limit");
  });

  it("shows inline upload error alert after a failed upload", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "File size exceeds 50MB limit" }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["test"], "large.bin", { type: "application/octet-stream" });
    await act(async () => {
      await expect(capturedUploadFile!(file)).rejects.toThrow("File size exceeds 50MB limit");
    });

    const alert = screen.getByTestId("note-editor-upload-error");
    expect(alert).toHaveTextContent("File size exceeds 50MB limit");
    expect(alert).toHaveAttribute("role", "alert");
  });

  it("throws when direct upload to Supabase fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          signedUrl: "https://storage.supabase.co/upload/sign/path",
          token: "tok",
          filePath: "user-1/note-42/file.bin",
          fileName: "file.bin",
        }),
    });
    mockUploadToSignedUrl.mockResolvedValue({
      error: { message: "Storage quota exceeded" },
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["test"], "file.bin", { type: "application/octet-stream" });
    await expect(capturedUploadFile!(file)).rejects.toThrow(
      "Upload failed: Storage quota exceeded",
    );
  });

  it("throws when confirm API returns an error", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            signedUrl: "https://storage.supabase.co/upload",
            token: "tok",
            filePath: "user-1/note-42/file.bin",
            fileName: "file.bin",
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "Failed to save attachment record" }),
      });
    mockUploadToSignedUrl.mockResolvedValue({ error: null });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["test"], "file.bin", { type: "application/octet-stream" });
    await expect(capturedUploadFile!(file)).rejects.toThrow("Failed to save attachment record");
  });

  it("shows the storage-full message when upload-url refuses for the quota", async () => {
    const usedBytes = DEFAULT_STORAGE_QUOTA_BYTES - 100;
    mockFetch.mockResolvedValue({
      ok: false,
      status: 413,
      json: () =>
        Promise.resolve({
          error: STORAGE_QUOTA_EXCEEDED_MESSAGE,
          code: STORAGE_QUOTA_EXCEEDED_CODE,
          usedBytes,
          quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
          status: 413,
        }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const expected = storageFullMessage(usedBytes, DEFAULT_STORAGE_QUOTA_BYTES);
    const file = new File(["test"], "photo.png", { type: "image/png" });
    mockGetBlock.mockReturnValue({ id: "block-1" });
    await act(async () => {
      await expect(capturedUploadFile!(file, "block-1")).rejects.toThrow(expected);
    });

    expect(mockUploadToSignedUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId("note-editor-upload-error")).toHaveTextContent(expected);
    // The placeholder image block goes, so BlockNote's own generic "Upload failed"
    // has nowhere to show and no empty image block is left in the note.
    expect(mockGetBlock).toHaveBeenCalledWith("block-1");
    expect(mockRemoveBlocks).toHaveBeenCalledWith(["block-1"]);
  });

  it("leaves the editor alone on a storage-full refusal when the block is already gone", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 413,
      json: () =>
        Promise.resolve({
          error: STORAGE_QUOTA_EXCEEDED_MESSAGE,
          code: STORAGE_QUOTA_EXCEEDED_CODE,
          usedBytes: 10,
          quotaBytes: 10,
          status: 413,
        }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    mockGetBlock.mockReturnValue(undefined);
    const file = new File(["test"], "photo.png", { type: "image/png" });
    await act(async () => {
      await expect(capturedUploadFile!(file, "block-1")).rejects.toThrow(
        storageFullMessage(10, 10),
      );
    });

    expect(mockRemoveBlocks).not.toHaveBeenCalled();
  });

  it("shows the storage-full message when confirm refuses for the quota", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            signedUrl: "https://storage.supabase.co/upload",
            token: "tok",
            filePath: "user-1/note-42/photo.png",
            fileName: "photo.png",
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: () =>
          Promise.resolve({
            error: STORAGE_QUOTA_EXCEEDED_MESSAGE,
            code: STORAGE_QUOTA_EXCEEDED_CODE,
            usedBytes: null,
            quotaBytes: null,
            status: 413,
          }),
      });
    mockUploadToSignedUrl.mockResolvedValue({ error: null });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const expected = storageFullMessage(null, null);
    const file = new File(["test"], "photo.png", { type: "image/png" });
    mockGetBlock.mockReturnValue({ id: "block-7" });
    await act(async () => {
      await expect(capturedUploadFile!(file, "block-7")).rejects.toThrow(expected);
    });

    expect(screen.getByTestId("note-editor-upload-error")).toHaveTextContent(expected);
    expect(mockRemoveBlocks).toHaveBeenCalledWith(["block-7"]);
  });

  it("keeps the per-file size message for a 413 without the quota code", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 413,
      json: () => Promise.resolve({ error: "File size exceeds 50MB limit", status: 413 }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["test"], "large.bin", { type: "application/octet-stream" });
    mockGetBlock.mockReturnValue({ id: "block-1" });
    await act(async () => {
      await expect(capturedUploadFile!(file, "block-1")).rejects.toThrow(
        "File size exceeds 50MB limit",
      );
    });

    // Only a storage-full refusal removes the block; other failures keep
    // BlockNote's panel so the user can pick another file.
    expect(mockRemoveBlocks).not.toHaveBeenCalled();
  });

  it("throws when confirm succeeds but file_path is missing from response", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            signedUrl: "https://storage.supabase.co/upload",
            token: "tok",
            filePath: "user-1/note-42/test.png",
            fileName: "test.png",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "att-1", file_name: "test.png", file_path: null }),
      });
    mockUploadToSignedUrl.mockResolvedValue({ error: null });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["test"], "test.png", { type: "image/png" });
    await expect(capturedUploadFile!(file)).rejects.toThrow(
      "Upload succeeded but no file path was returned",
    );
  });

  it("rejects empty files client-side", async () => {
    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    mockFetch.mockClear();
    const file = new File([], "empty.txt", { type: "text/plain" });
    await expect(capturedUploadFile!(file)).rejects.toThrow("File is empty");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects files over MAX_FILE_SIZE client-side without contacting the server", async () => {
    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    mockFetch.mockClear();
    // 50 MB + 1 byte — larger than MAX_FILE_SIZE
    const file = new File([new Uint8Array(52428801)], "huge.bin", {
      type: "application/octet-stream",
    });
    await act(async () => {
      await expect(capturedUploadFile!(file)).rejects.toThrow("File size exceeds 50MB limit");
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("note-editor-upload-error")).toHaveTextContent(
      "File size exceeds 50MB limit",
    );
  });

  it("clears the inline upload error when the dismiss button is clicked", async () => {
    const { fireEvent } = await import("@testing-library/react");
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "File size exceeds 50MB limit" }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["x"], "large.bin", { type: "application/octet-stream" });
    await act(async () => {
      await expect(capturedUploadFile!(file)).rejects.toThrow();
    });

    const alert = screen.getByTestId("note-editor-upload-error");
    expect(alert).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    });

    expect(screen.queryByTestId("note-editor-upload-error")).not.toBeInTheDocument();
  });

  it("provides resolveFileUrl that resolves attachment:// URLs via API", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          signedUrl:
            "https://test.supabase.co/storage/v1/object/sign/attachments/u/n/img.png?token=fresh",
        }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-1" />);
    });

    expect(capturedResolveFileUrl).toBeDefined();
    const result = await capturedResolveFileUrl!("attachment://u/n/img.png");

    expect(result).toBe(
      "https://test.supabase.co/storage/v1/object/sign/attachments/u/n/img.png?token=fresh",
    );
    expect(mockFetch).toHaveBeenCalledWith("/api/attachments/resolve-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "u/n/img.png" }),
    });
  });

  it("resolveFileUrl passes through non-attachment URLs unchanged", async () => {
    await act(async () => {
      render(<NoteEditor noteId="note-1" />);
    });

    expect(capturedResolveFileUrl).toBeDefined();
    mockFetch.mockClear();
    const signedUrl =
      "https://test.supabase.co/storage/v1/object/sign/attachments/u/n/img.png?token=abc";
    const result = await capturedResolveFileUrl!(signedUrl);

    expect(result).toBe(signedUrl);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolveFileUrl throws when API returns an error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Forbidden" }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-1" />);
    });

    await expect(capturedResolveFileUrl!("attachment://u/n/img.png")).rejects.toThrow(
      "Failed to resolve attachment URL",
    );
  });
});
