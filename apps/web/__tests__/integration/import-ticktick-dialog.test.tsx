import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportTickTickDialog } from "@/components/import/import-ticktick-dialog";

vi.mock("@/lib/import/ticktick-parser", () => ({
  parseTickTickCsv: vi.fn(() => [
    {
      notebookName: "Work / Inbox",
      items: [
        {
          folderName: "Work",
          listName: "Inbox",
          title: "Sample task",
          content: "body",
          isCheckList: false,
          created: "2025-01-01T00:00:00.000Z",
          updated: "2025-01-01T00:00:00.000Z",
        },
      ],
    },
  ]),
}));

vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: vi.fn(() => false),
}));

describe("ImportTickTickDialog", () => {
  const mockOnClose = vi.fn();
  const mockOnComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("renders the dialog with file input and import button", () => {
    render(<ImportTickTickDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    expect(screen.getByText("Import from TickTick")).toBeInTheDocument();
    expect(screen.getByTestId("ticktick-file-input")).toBeInTheDocument();
    expect(screen.getByTestId("start-ticktick-import-button")).toBeInTheDocument();
  });

  it("disables import button when no file is selected", () => {
    render(<ImportTickTickDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    expect(screen.getByTestId("start-ticktick-import-button")).toBeDisabled();
  });

  it("calls onClose when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<ImportTickTickDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("shows a success status after a successful import", async () => {
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

    render(<ImportTickTickDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    const file = new File(["List Name,Title\nInbox,Real"], "ticktick-export.csv", {
      type: "text/csv",
    });
    await user.upload(screen.getByTestId("ticktick-file-input"), file);
    await user.click(screen.getByTestId("start-ticktick-import-button"));

    const status = await screen.findByTestId("ticktick-import-status");
    expect(status.textContent).toContain("1 notes imported");
    expect(mockOnComplete).toHaveBeenCalledWith("nb-1");
  });

  it("shows an error when parsing fails", async () => {
    const user = userEvent.setup();
    const { parseTickTickCsv } = await import("@/lib/import/ticktick-parser");
    (parseTickTickCsv as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("CSV parsing failed");
    });

    render(<ImportTickTickDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    const file = new File(["bad"], "broken.csv", { type: "text/csv" });
    await user.upload(screen.getByTestId("ticktick-file-input"), file);
    await user.click(screen.getByTestId("start-ticktick-import-button"));

    const errorEl = await screen.findByTestId("ticktick-import-error");
    expect(errorEl.textContent).toContain("CSV parsing failed");
  });

  it("shows an error when no items are found", async () => {
    const user = userEvent.setup();
    const { parseTickTickCsv } = await import("@/lib/import/ticktick-parser");
    (parseTickTickCsv as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

    render(<ImportTickTickDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    const file = new File(["empty"], "empty.csv", { type: "text/csv" });
    await user.upload(screen.getByTestId("ticktick-file-input"), file);
    await user.click(screen.getByTestId("start-ticktick-import-button"));

    const errorEl = await screen.findByTestId("ticktick-import-error");
    expect(errorEl.textContent).toContain("No items found");
  });

  it("reports failures returned by the API", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          notebookId: "nb-1",
          notesImported: 0,
          notesFailed: 1,
          errors: ["Bad row"],
        }),
    });

    render(<ImportTickTickDialog onClose={mockOnClose} onComplete={mockOnComplete} />);

    const file = new File(["x"], "ticktick.csv", { type: "text/csv" });
    await user.upload(screen.getByTestId("ticktick-file-input"), file);
    await user.click(screen.getByTestId("start-ticktick-import-button"));

    const status = await screen.findByTestId("ticktick-import-status");
    expect(status.textContent).toContain("0 imported, 1 failed");
  });
});
