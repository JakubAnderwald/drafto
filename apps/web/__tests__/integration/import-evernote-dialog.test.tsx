import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportEvernoteDialog } from "@/components/import/import-evernote-dialog";
import type { EnexNote } from "@/lib/import/types";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  STORAGE_QUOTA_EXCEEDED_CODE,
  STORAGE_QUOTA_EXCEEDED_MESSAGE,
  storageFullMessage,
} from "@drafto/shared";

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

    // Retry resumes the same note row (finalize call #3 succeeds) — no duplicate.
    await user.click(screen.getByTestId("retry-failed-button"));
    const finalStatus = await screen.findByTestId("import-status");
    expect(finalStatus.textContent).toContain("2 notes imported");
    expect(screen.queryByTestId("retry-failed-button")).not.toBeInTheDocument();
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

  it("uploads a note's attachment directly and references it in finalize", async () => {
    const user = userEvent.setup();
    const finalizeBodies: Array<{ attachments: Array<{ url: string }> }> = [];
    mockParseEnexStream.mockImplementation(() =>
      streamOf(note({ resources: [{ data: "aGVsbG8=", mime: "image/png", fileName: "pic.png" }] })),
    );
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/import/evernote/note"))
        return jsonOk({ notebookId: "nb-1", noteId: "note-1" });
      if (url.includes("/api/import/evernote/finalize")) {
        finalizeBodies.push(JSON.parse(String(init?.body)));
        return jsonOk({ noteId: "note-1" });
      }
      if (url.includes("/upload-url"))
        return jsonOk({ token: "t", filePath: "user-1/note-1/pic.png" });
      if (url.includes("/confirm")) return jsonOk({ file_path: "user-1/note-1/pic.png" });
      return jsonOk({});
    }) as unknown as typeof fetch;

    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    await user.upload(screen.getByTestId("file-input"), new File(["x"], "n.enex"));
    await user.click(screen.getByTestId("start-import-button"));

    expect((await screen.findByTestId("import-status")).textContent).toContain("1 notes imported");
    expect(mockUploadToSignedUrl).toHaveBeenCalled();
    expect(finalizeBodies[0].attachments).toHaveLength(1);
    expect(finalizeBodies[0].attachments[0].url).toBe("attachment://user-1/note-1/pic.png");
  });

  it("skips a failed attachment but still imports the note's text", async () => {
    const user = userEvent.setup();
    mockParseEnexStream.mockImplementation(() =>
      streamOf(note({ resources: [{ data: "aGVsbG8=", mime: "image/png", fileName: "pic.png" }] })),
    );
    mockUploadToSignedUrl.mockResolvedValueOnce({ error: { message: "network down" } });

    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    await user.upload(screen.getByTestId("file-input"), new File(["x"], "n.enex"));
    await user.click(screen.getByTestId("start-import-button"));

    const skipped = await screen.findByTestId("import-skipped-list");
    expect(skipped.textContent).toContain("pic.png");
    expect((await screen.findByTestId("import-status")).textContent).toContain("1 notes imported");
  });

  it("shows 'No notes found' for an empty .enex", async () => {
    const user = userEvent.setup();
    mockParseEnexStream.mockImplementation(() => streamOf());

    render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
    await user.upload(screen.getByTestId("file-input"), new File(["x"], "empty.enex"));
    await user.click(screen.getByTestId("start-import-button"));

    expect((await screen.findByTestId("import-error")).textContent).toContain("No notes found");
  });

  describe("storage quota", () => {
    const usedBytes = DEFAULT_STORAGE_QUOTA_BYTES - 2;
    const quotaRefusal = () =>
      Promise.resolve({
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
    const pic = (fileName: string) => ({ data: "aGVsbG8=", mime: "image/png", fileName });

    /**
     * Routes the import's requests: each created note gets its own id, and `refuse`
     * decides which upload step answers the quota 413.
     */
    function quotaFetch(refuse: (step: "upload-url" | "confirm", call: number) => boolean) {
      const calls = { note: 0, finalize: [] as Array<{ noteId: string; attachments: unknown[] }> };
      let uploadUrlCalls = 0;
      let confirmCalls = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/import/evernote/note")) {
          calls.note += 1;
          return jsonOk({ notebookId: "nb-1", noteId: `note-${calls.note}` });
        }
        if (url.includes("/api/import/evernote/finalize")) {
          calls.finalize.push(JSON.parse(String(init?.body)));
          return jsonOk({ noteId: "note-x" });
        }
        if (url.includes("/upload-url")) {
          uploadUrlCalls += 1;
          if (refuse("upload-url", uploadUrlCalls)) return quotaRefusal();
          return jsonOk({ token: "t", filePath: `user-1/f-${uploadUrlCalls}.png` });
        }
        if (url.includes("/confirm")) {
          confirmCalls += 1;
          if (refuse("confirm", confirmCalls)) return quotaRefusal();
          return jsonOk({ file_path: `user-1/f-${confirmCalls}.png` });
        }
        return jsonOk({});
      });
      return {
        fetchMock,
        calls,
        uploadUrlCalls: () => uploadUrlCalls,
      };
    }

    const expectedMessage = `${storageFullMessage(usedBytes, DEFAULT_STORAGE_QUOTA_BYTES)} The remaining notes weren't imported.`;

    it("stops at the first quota refusal, keeps the earlier notes and doesn't retry", async () => {
      const user = userEvent.setup();
      mockParseEnexStream.mockImplementation(() =>
        streamOf(
          note({ title: "First", resources: [pic("a.png")] }),
          note({ title: "Second", resources: [pic("b.png"), pic("c.png")] }),
          note({ title: "Third", resources: [pic("d.png")] }),
        ),
      );
      // The second note's second attachment (upload-url call #3) hits the quota.
      const { fetchMock, calls, uploadUrlCalls } = quotaFetch(
        (step, call) => step === "upload-url" && call === 3,
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
      await user.upload(screen.getByTestId("file-input"), new File(["x"], "n.enex"));
      await user.click(screen.getByTestId("start-import-button"));

      expect((await screen.findByTestId("import-error")).textContent).toBe(expectedMessage);
      // The third note was never created, and the refused upload was not tried again.
      expect(calls.note).toBe(2);
      expect(uploadUrlCalls()).toBe(3);
      // The second note was still finalized — its text kept, with the attachment that fit.
      expect(calls.finalize).toHaveLength(2);
      expect(calls.finalize[1].noteId).toBe("note-2");
      expect(calls.finalize[1].attachments).toHaveLength(1);
      expect((await screen.findByTestId("import-status")).textContent).toContain(
        "Stopped: 2 imported",
      );
      // Nothing offers to retry the notes the quota cut off, and the refusal isn't a skip.
      expect(screen.queryByTestId("retry-failed-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("import-failed-list")).not.toBeInTheDocument();
      expect(screen.queryByTestId("import-skipped-list")).not.toBeInTheDocument();
      expect(screen.queryByTestId("start-import-button")).not.toBeInTheDocument();
      // The message stays up until the user closes; closing opens the notebook.
      expect(mockOnComplete).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: /close/i }));
      expect(mockOnComplete).toHaveBeenCalledWith("nb-1");
      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it("stops when confirm refuses for the quota", async () => {
      const user = userEvent.setup();
      mockParseEnexStream.mockImplementation(() =>
        streamOf(
          note({ title: "First", resources: [pic("a.png")] }),
          note({ title: "Second", resources: [pic("b.png")] }),
        ),
      );
      const { fetchMock, calls } = quotaFetch((step, call) => step === "confirm" && call === 1);
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
      await user.upload(screen.getByTestId("file-input"), new File(["x"], "n.enex"));
      await user.click(screen.getByTestId("start-import-button"));

      expect((await screen.findByTestId("import-error")).textContent).toBe(expectedMessage);
      expect(calls.note).toBe(1);
      expect(calls.finalize).toHaveLength(1);
      expect(calls.finalize[0].attachments).toHaveLength(0);
      expect((await screen.findByTestId("import-status")).textContent).toContain(
        "Stopped: 1 imported",
      );
    });

    it("stops when the refused note's finalize fails, and lists that note for retry", async () => {
      const user = userEvent.setup();
      mockParseEnexStream.mockImplementation(() =>
        streamOf(
          note({ title: "First", resources: [pic("a.png")] }),
          note({ title: "Second", resources: [] }),
        ),
      );
      let noteCalls = 0;
      global.fetch = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/import/evernote/note")) {
          noteCalls += 1;
          return jsonOk({ notebookId: "nb-1", noteId: `note-${noteCalls}` });
        }
        if (url.includes("/api/import/evernote/finalize")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: "boom" }),
          });
        }
        if (url.includes("/upload-url")) return quotaRefusal();
        return jsonOk({});
      }) as unknown as typeof fetch;

      render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
      await user.upload(screen.getByTestId("file-input"), new File(["x"], "n.enex"));
      await user.click(screen.getByTestId("start-import-button"));

      expect((await screen.findByTestId("import-error")).textContent).toBe(expectedMessage);
      expect(noteCalls).toBe(1);
      expect((await screen.findByTestId("import-status")).textContent).toContain(
        "Stopped: 0 imported",
      );
      // Its text was never written, so it must stay retryable.
      expect(await screen.findByTestId("retry-failed-button")).toBeInTheDocument();
    });

    it("keeps the untried notes on the retry list when a retry stops at the quota", async () => {
      const user = userEvent.setup();
      mockParseEnexStream.mockImplementation(() =>
        streamOf(
          note({ title: "Alpha", resources: [pic("a.png")] }),
          note({ title: "Bravo", resources: [pic("b.png")] }),
          note({ title: "Charlie", resources: [pic("c.png")] }),
        ),
      );
      // First run: every finalize fails, so all three notes go on the retry list.
      // Retry: the first retried note's upload hits the quota.
      let retrying = false;
      let noteCalls = 0;
      const finalized: string[] = [];
      global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/import/evernote/note")) {
          noteCalls += 1;
          return jsonOk({ notebookId: "nb-1", noteId: `note-${noteCalls}` });
        }
        if (url.includes("/api/import/evernote/finalize")) {
          if (!retrying) {
            return Promise.resolve({
              ok: false,
              status: 500,
              json: () => Promise.resolve({ error: "boom" }),
            });
          }
          finalized.push(JSON.parse(String(init?.body)).noteId);
          return jsonOk({ noteId: "note-x" });
        }
        if (url.includes("/upload-url")) {
          return retrying ? quotaRefusal() : jsonOk({ token: "t", filePath: "user-1/f.png" });
        }
        if (url.includes("/confirm")) return jsonOk({ file_path: "user-1/f.png" });
        return jsonOk({});
      }) as unknown as typeof fetch;

      render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
      await user.upload(screen.getByTestId("file-input"), new File(["x"], "n.enex"));
      await user.click(screen.getByTestId("start-import-button"));
      expect((await screen.findByTestId("import-status")).textContent).toContain(
        "0 imported, 3 failed",
      );

      retrying = true;
      await user.click(screen.getByTestId("retry-failed-button"));

      expect((await screen.findByTestId("import-error")).textContent).toBe(expectedMessage);
      // The retry resumed the first note's row and stopped there: no note was created again.
      expect(noteCalls).toBe(3);
      expect(finalized).toEqual(["note-1"]);
      expect((await screen.findByTestId("import-status")).textContent).toContain(
        "Stopped: 1 imported, 2 failed",
      );
      // The two notes the retry never reached can still be resumed.
      const failedList = screen.getByTestId("import-failed-list");
      expect(failedList.textContent).not.toContain("Alpha");
      expect(failedList.textContent).toContain("Bravo");
      expect(failedList.textContent).toContain("Charlie");
      expect(screen.getByTestId("retry-failed-button")).toBeInTheDocument();
    });

    it("treats a 413 without the quota code as a skipped attachment", async () => {
      const user = userEvent.setup();
      mockParseEnexStream.mockImplementation(() =>
        streamOf(note({ title: "Only", resources: [pic("big.png")] })),
      );
      const base = routeFetch();
      global.fetch = vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/upload-url")
          ? Promise.resolve({
              ok: false,
              status: 413,
              json: () => Promise.resolve({ error: "File size exceeds 50MB limit", status: 413 }),
            })
          : base(input),
      ) as unknown as typeof fetch;

      render(<ImportEvernoteDialog onClose={mockOnClose} onComplete={mockOnComplete} />);
      await user.upload(screen.getByTestId("file-input"), new File(["x"], "n.enex"));
      await user.click(screen.getByTestId("start-import-button"));

      expect((await screen.findByTestId("import-skipped-list")).textContent).toContain(
        "File size exceeds 50MB limit",
      );
      expect((await screen.findByTestId("import-status")).textContent).toContain(
        "1 notes imported",
      );
      expect(screen.queryByTestId("import-error")).not.toBeInTheDocument();
    });
  });
});
