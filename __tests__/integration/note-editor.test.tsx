import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";

// Mock BlockNote dependencies — they require a real DOM canvas, which jsdom lacks
vi.mock("@blocknote/react", () => ({
  useCreateBlockNote: () => ({
    document: [],
  }),
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

const { NoteEditor } = await import("@/components/editor/note-editor");

describe("NoteEditor", () => {
  it("renders without crashing", async () => {
    await act(async () => {
      render(<NoteEditor />);
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
          initialContent={initialContent as Parameters<typeof NoteEditor>[0]["initialContent"]}
        />,
      );
    });

    expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
  });

  it("accepts an onChange callback", async () => {
    const onChange = vi.fn();

    await act(async () => {
      render(<NoteEditor onChange={onChange} />);
    });

    // The editor renders — onChange is passed through to BlockNoteView
    expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
  });

  it("wraps the editor in a scrollable container", async () => {
    await act(async () => {
      render(<NoteEditor />);
    });

    const container = screen.getByTestId("blocknote-editor").parentElement;
    expect(container).toHaveClass("flex-1", "overflow-y-auto");
  });
});
