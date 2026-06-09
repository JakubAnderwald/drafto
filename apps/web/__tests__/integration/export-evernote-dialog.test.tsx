import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportEvernoteDialog } from "@/components/export/export-evernote-dialog";

vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: vi.fn(() => false),
}));

const downloadBlob = vi.fn();
vi.mock("@/lib/export/download-blob", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
  filenameFromContentDisposition: (value: string | null): string | null => {
    if (!value) return null;
    const match = value.match(/filename\s*=\s*"?([^";]+)"?/i);
    return match?.[1] ?? null;
  },
}));

const notebooks = [
  { id: "nb-1", name: "Inbox", noteCount: 3 },
  { id: "nb-2", name: "Empty", noteCount: 0 },
  { id: "nb-3", name: "Archive", noteCount: 1 },
];

function mockGetResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
    blob: async () => new Blob([]),
  } as unknown as Response;
}

describe("ExportEvernoteDialog", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("shows the loading state then pre-selects notebooks with notes", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockGetResponse({ notebooks }),
    );

    render(<ExportEvernoteDialog onClose={onClose} />);

    expect(screen.getByTestId("export-loading")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("export-select-all")).toBeInTheDocument();
    });

    const cb1 = screen.getByTestId("export-checkbox-nb-1") as HTMLInputElement;
    const cb2 = screen.getByTestId("export-checkbox-nb-2") as HTMLInputElement;
    const cb3 = screen.getByTestId("export-checkbox-nb-3") as HTMLInputElement;
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(false);
    expect(cb3.checked).toBe(true);

    expect(screen.getByTestId("export-counts").textContent).toContain("2 notebooks");
    expect(screen.getByTestId("export-counts").textContent).toContain("4 notes");
  });

  it("renders empty-state message when there are no notebooks", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockGetResponse({ notebooks: [] }),
    );

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText("No notebooks to export.")).toBeInTheDocument();
    });
    // Counts use singular variants for a single value.
    expect(screen.getByTestId("export-counts").textContent).toContain("0 notebooks");
    expect(screen.getByTestId("export-counts").textContent).toContain("0 notes");
  });

  it("renders an error state when the GET response is not ok", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockGetResponse({ error: "boom" }, 500),
    );

    render(<ExportEvernoteDialog onClose={onClose} />);

    const err = await screen.findByTestId("export-error");
    expect(err.textContent).toContain("Failed to load notebooks");
  });

  it("renders an error state when the GET fetch rejects", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));

    render(<ExportEvernoteDialog onClose={onClose} />);

    const err = await screen.findByTestId("export-error");
    expect(err.textContent).toContain("offline");
  });

  it("toggles individual selection and selectAll / deselectAll", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockGetResponse({ notebooks }),
    );

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("export-select-all")).toBeInTheDocument();
    });

    const cb2 = screen.getByTestId("export-checkbox-nb-2") as HTMLInputElement;
    await user.click(cb2);
    expect(cb2.checked).toBe(true);
    await user.click(cb2);
    expect(cb2.checked).toBe(false);

    await user.click(screen.getByTestId("export-select-all"));
    const cb1 = screen.getByTestId("export-checkbox-nb-1") as HTMLInputElement;
    const cb3 = screen.getByTestId("export-checkbox-nb-3") as HTMLInputElement;
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(true);
    expect(cb3.checked).toBe(true);

    await user.click(screen.getByTestId("export-deselect-all"));
    expect(cb1.checked).toBe(false);
    expect(cb2.checked).toBe(false);
    expect(cb3.checked).toBe(false);
  });

  it("invokes onClose when Cancel is clicked", async () => {
    const user = userEvent.setup();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockGetResponse({ notebooks }),
    );

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("export-select-all")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("triggers a download with the server-provided filename on a successful export", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["<en-export/>"]);

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockGetResponse({ notebooks }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Disposition": 'attachment; filename="Inbox.enex"' }),
        text: async () => "",
        blob: async () => blob,
      } as unknown as Response);

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("export-select-all")).toBeInTheDocument());

    // Deselect the second pre-selected notebook so we exercise the single-selection
    // filename path (used by defaultFilename when the server omits the header).
    await user.click(screen.getByTestId("export-checkbox-nb-3"));
    await user.click(screen.getByTestId("export-start-button"));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const [, filename] = downloadBlob.mock.calls[0];
    expect(filename).toBe("Inbox.enex");

    // Done state is rendered and replaces the Export button with a Close action.
    expect(screen.getByText("Your .enex file has been downloaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("falls back to a sanitised single-notebook filename when the header is missing", async () => {
    const user = userEvent.setup();
    const blob = new Blob([]);

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        mockGetResponse({ notebooks: [{ id: "nb-1", name: "Inbox / Today!", noteCount: 1 }] }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "",
        blob: async () => blob,
      } as unknown as Response);

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("export-select-all")).toBeInTheDocument());
    await user.click(screen.getByTestId("export-start-button"));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const [, filename] = downloadBlob.mock.calls[0];
    expect(filename).toBe("Inbox-Today.enex");
  });

  it("falls back to drafto-export-<date>.enex for a multi-notebook export", async () => {
    const user = userEvent.setup();
    const blob = new Blob([]);

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockGetResponse({ notebooks }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "",
        blob: async () => blob,
      } as unknown as Response);

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("export-select-all")).toBeInTheDocument());
    // nb-1 + nb-3 pre-selected → multi-notebook path.
    await user.click(screen.getByTestId("export-start-button"));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const [, filename] = downloadBlob.mock.calls[0];
    expect(filename).toMatch(/^drafto-export-\d{4}-\d{2}-\d{2}\.enex$/);
  });

  it("surfaces the server error message when the POST fails with a JSON body", async () => {
    const user = userEvent.setup();

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockGetResponse({ notebooks }))
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: "Too big" }),
        blob: async () => new Blob([]),
      } as unknown as Response);

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("export-select-all")).toBeInTheDocument());
    await user.click(screen.getByTestId("export-start-button"));

    const err = await screen.findByTestId("export-error");
    expect(err.textContent).toContain("Too big");
  });

  it("falls back to a status-coded message when the POST fails with a non-JSON body", async () => {
    const user = userEvent.setup();

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockGetResponse({ notebooks }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => "<html>500</html>",
        blob: async () => new Blob([]),
      } as unknown as Response);

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("export-select-all")).toBeInTheDocument());
    await user.click(screen.getByTestId("export-start-button"));

    const err = await screen.findByTestId("export-error");
    expect(err.textContent).toContain("Export failed (500)");
  });

  it("surfaces a network error when the POST fetch rejects", async () => {
    const user = userEvent.setup();

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockGetResponse({ notebooks }))
      .mockRejectedValueOnce(new Error("ECONNRESET"));

    render(<ExportEvernoteDialog onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId("export-select-all")).toBeInTheDocument());
    await user.click(screen.getByTestId("export-start-button"));

    const err = await screen.findByTestId("export-error");
    expect(err.textContent).toContain("ECONNRESET");
  });
});
