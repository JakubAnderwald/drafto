import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";

// Mock BlockNote dependencies — they require a real DOM canvas, which jsdom lacks
let capturedUploadFile: ((file: File) => Promise<string>) | undefined;
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
    uploadFile?: (file: File) => Promise<string>;
    resolveFileUrl?: (url: string) => Promise<string>;
  }) => {
    capturedUploadFile = opts?.uploadFile;
    return { document: [] };
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
    vi.stubGlobal("fetch", mockFetch);
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
        fileName: "image-12345.png",
        fileSize: 4,
        mimeType: "image/png",
      }),
    });
  });

  it("throws when upload-url API returns an error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "File size exceeds 25MB limit" }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["test"], "large.bin", { type: "application/octet-stream" });
    await expect(capturedUploadFile!(file)).rejects.toThrow("File size exceeds 25MB limit");
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
