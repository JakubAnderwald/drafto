import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportEvernoteDialog } from "@/components/import/import-evernote-dialog";

// Mock enex parser
vi.mock("@/lib/import/enex-parser", () => ({
  parseEnexFile: vi.fn(() => [
    {
      title: "Test Note",
      content: "<en-note><p>Hello</p></en-note>",
      created: "2023-01-01T00:00:00.000Z",
      updated: "2023-01-01T00:00:00.000Z",
      resources: [],
    },
  ]),
}));

// Mock handle-auth-error
vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: vi.fn(() => false),
}));

describe("ImportEvernoteDialog", () => {
  const mockOnClose = vi.fn();
  const mockOnComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
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

    const button = screen.getByTestId("start-import-button");
    expect(button).toBeDisabled();
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

    const file = new File(["<en-export></en-export>"], "My Notes.enex", {
      type: "text/xml",
    });

    const fileInput = screen.getByTestId("file-input");
    await user.upload(fileInput, file);

    const nameInput = screen.getByTestId("notebook-name-input") as HTMLInputElement;
    expect(nameInput.value).toBe("My Notes");
  });

  it("shows success status after successful import", async () => {
    const user = userEvent.setup();

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          notebookId: "nb-1",
          notesImported: 1,
          notesFailed: 0,
          errors: [],
        }),
    });

    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    const file = new File(
      [
        '<?xml version="1.0"?><en-export><note><title>Test</title><content>test</content><created>20230101T000000Z</created></note></en-export>',
      ],
      "notes.enex",
      { type: "text/xml" },
    );

    const fileInput = screen.getByTestId("file-input");
    await user.upload(fileInput, file);
    await user.click(screen.getByTestId("start-import-button"));

    // Wait for import to finish
    const statusEl = await screen.findByTestId("import-status");
    expect(statusEl.textContent).toContain("1 notes imported");
    expect(mockOnComplete).toHaveBeenCalledWith("nb-1");
  });

  it("shows error when parsing fails", async () => {
    const user = userEvent.setup();

    // Override the mock to throw
    const { parseEnexFile } = await import("@/lib/import/enex-parser");
    (parseEnexFile as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("XML parsing failed");
    });

    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    const file = new File(["bad xml"], "broken.enex", { type: "text/xml" });
    const fileInput = screen.getByTestId("file-input");
    await user.upload(fileInput, file);
    await user.click(screen.getByTestId("start-import-button"));

    const errorEl = await screen.findByTestId("import-error");
    expect(errorEl.textContent).toContain("XML parsing failed");
  });
});
