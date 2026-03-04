import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";

// Mock BlockNote dependencies — they require a real DOM canvas, which jsdom lacks
let capturedUploadFile: ((file: File) => Promise<string>) | undefined;

vi.mock("@blocknote/react", () => ({
  useCreateBlockNote: (opts?: { uploadFile?: (file: File) => Promise<string> }) => {
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

  it("passes custom theme with CSS variable colors to BlockNoteView", async () => {
    const { BlockNoteView } = await import("@blocknote/mantine");
    const mockBlockNoteView = vi.mocked(BlockNoteView);
    mockBlockNoteView.mockClear();

    await act(async () => {
      render(<NoteEditor noteId="note-1" />);
    });

    const props = mockBlockNoteView.mock.calls[0]?.[0] as Record<string, unknown>;
    const theme = props?.theme as {
      colors: Record<string, unknown>;
      borderRadius: number;
      fontFamily: string;
    };

    expect(theme.colors.editor).toEqual({ text: "var(--fg)", background: "var(--bg)" });
    expect(theme.colors.menu).toEqual({ text: "var(--fg)", background: "var(--bg)" });
    expect(theme.colors.selected).toEqual({
      text: "var(--fg-on-primary)",
      background: "var(--ring)",
    });
    expect(theme.colors.border).toBe("var(--border)");
    expect(theme.colors.sideMenu).toBe("var(--fg-subtle)");
    expect(theme.borderRadius).toBe(6);
    expect(theme.fontFamily).toBe("var(--font-sans, Arial, Helvetica, sans-serif)");
  });

  it("wraps the editor in a scrollable container", async () => {
    await act(async () => {
      render(<NoteEditor noteId="note-1" />);
    });

    const container = screen.getByTestId("blocknote-editor").parentElement;
    expect(container).toHaveAttribute("data-testid", "editor-scroll-container");
  });

  it("provides uploadFile handler to BlockNote that uploads to the attachments API", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "att-1",
          file_name: "image.png",
          url: "https://example.com/signed-url",
        }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    expect(capturedUploadFile).toBeDefined();
    const file = new File(["test"], "image.png", { type: "image/png" });
    const url = await capturedUploadFile!(file);

    expect(url).toBe("https://example.com/signed-url");
    expect(mockFetch).toHaveBeenCalledWith("/api/notes/note-42/attachments", {
      method: "POST",
      body: expect.any(FormData),
    });
  });

  it("throws when upload API returns an error", async () => {
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

  it("throws when upload succeeds but URL is missing from response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "att-1", file_name: "test.png", url: null }),
    });

    await act(async () => {
      render(<NoteEditor noteId="note-42" />);
    });

    const file = new File(["test"], "test.png", { type: "image/png" });
    await expect(capturedUploadFile!(file)).rejects.toThrow(
      "Upload succeeded but no file URL was returned",
    );
  });
});
