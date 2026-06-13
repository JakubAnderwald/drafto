import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportEvernoteDialog } from "@/components/import/import-evernote-dialog";
import type { EnexNote } from "@/lib/import/types";

const mockParseEnexStream = vi.fn();

vi.mock("@/lib/import/enex-stream-parser", () => ({
  parseEnexStream: (...args: unknown[]) => mockParseEnexStream(...args),
}));

vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: vi.fn(() => false),
}));

const mockUploadToSignedUrl = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({
    storage: { from: () => ({ uploadToSignedUrl: mockUploadToSignedUrl }) },
  })),
}));

function note(overrides: Partial<EnexNote> = {}): EnexNote {
  return {
    title: "Test Note",
    content: "<en-note><p>Hello</p></en-note>",
    created: "2023-01-01T00:00:00.000Z",
    updated: "2023-01-01T00:00:00.000Z",
    resources: [],
    tasks: [],
    ...overrides,
  };
}

async function* streamOf(...notes: EnexNote[]): AsyncGenerator<EnexNote> {
  for (const n of notes) yield n;
}

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function routeFetch(overrides: Record<string, () => Promise<unknown>> = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/import/evernote/note")) {
      return (overrides.note ?? (() => jsonOk({ notebookId: "nb-1", noteId: "note-1" })))();
    }
    if (url.includes("/api/import/evernote/finalize")) {
      return (overrides.finalize ?? (() => jsonOk({ noteId: "note-1", blockCount: 1 })))();
    }
    if (url.includes("/upload-url")) return jsonOk({ token: "t", filePath: "user-1/note-1/f.png" });
    if (url.includes("/confirm")) return jsonOk({ file_path: "user-1/note-1/f.png" });
    return jsonOk({}); // DELETE /api/notes/[id], etc.
  });
}

describe("ImportEvernoteDialog", () => {
  const mockOnClose = vi.fn();
  const mockOnComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockParseEnexStream.mockImplementation(() => streamOf(note()));
    global.fetch = routeFetch() as unknown as typeof fetch;
  });

  it("renders the dialog with file input and notebook name", () => {
    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    expect(screen.getByText("Import from Evernote")).toBeInTheDocument();
    expect(screen.getByTestId("notebook-name-input")).toBeInTheDocument();
    expect(screen.getByTestId("file-input")).toBeInTheDocument();
    expect(screen.getByTestId("start-import-button")).toBeInTheDocument();
  });

  it("disables import button when no file selected", () => {
    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    expect(screen.getByTestId("start-import-button")).toBeDisabled();
  });

  it("calls onClose when cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("sets notebook name from filename when file is selected", async () => {
    const user = userEvent.setup();
    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    const file = new File(["<en-export></en-export>"], "My Notes.enex", { type: "text/xml" });
    await user.upload(screen.getByTestId("file-input"), file);
    expect((screen.getByTestId("notebook-name-input") as HTMLInputElement).value).toBe("My Notes");
  });

  it("imports notes and reports success", async () => {
    const user = userEvent.setup();
    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    const file = new File(["<en-export/>"], "notes.enex", { type: "text/xml" });
    await user.upload(screen.getByTestId("file-input"), file);
    await user.click(screen.getByTestId("start-import-button"));

    const statusEl = await screen.findByTestId("import-status");
    expect(statusEl.textContent).toContain("1 notes imported");
    expect(mockOnComplete).toHaveBeenCalledWith("nb-1");
  });

  it("isolates a failed note and offers retry without dropping the rest", async () => {
    const user = userEvent.setup();
    // Two notes; the first note's finalize fails once, the second succeeds.
    mockParseEnexStream.mockImplementation(() =>
      streamOf(note({ title: "Bad" }), note({ title: "Good" })),
    );
    let finalizeCalls = 0;
    global.fetch = routeFetch({
      finalize: () => {
        finalizeCalls += 1;
        return finalizeCalls === 1
          ? Promise.resolve({
              ok: false,
              status: 500,
              json: () => Promise.resolve({ error: "boom" }),
            })
          : jsonOk({ noteId: "note-1" });
      },
    }) as unknown as typeof fetch;

    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    await user.upload(screen.getByTestId("file-input"), new File(["x"], "n.enex"));
    await user.click(screen.getByTestId("start-import-button"));

    const failedList = await screen.findByTestId("import-failed-list");
    expect(failedList.textContent).toContain("Bad");
    // The good note still imported despite the bad one failing.
    expect((await screen.findByTestId("import-status")).textContent).toContain(
      "1 imported, 1 failed",
    );
    expect(screen.getByTestId("retry-failed-button")).toBeInTheDocument();
  });

  it("shows a fatal error when the stream cannot be parsed", async () => {
    const user = userEvent.setup();
    mockParseEnexStream.mockImplementation(async function* () {
      throw new Error("XML parsing failed");
    });

    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    await user.upload(screen.getByTestId("file-input"), new File(["bad"], "broken.enex"));
    await user.click(screen.getByTestId("start-import-button"));

    const errorEl = await screen.findByTestId("import-error");
    expect(errorEl.textContent).toContain("XML parsing failed");
  });
});
