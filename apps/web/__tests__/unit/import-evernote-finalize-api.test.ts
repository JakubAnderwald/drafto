import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ImportFinalizeRequest } from "@/lib/import/types";

const mockGetNoteOwner = vi.fn();
const mockErrorResponse = vi.fn();
const mockSuccessResponse = vi.fn();
const mockConvert = vi.fn();

vi.mock("@/lib/api/utils", () => ({
  getAuthenticatedNoteOwner: (...args: unknown[]) => mockGetNoteOwner(...args),
  errorResponse: (...args: unknown[]) => mockErrorResponse(...args),
  successResponse: (...args: unknown[]) => mockSuccessResponse(...args),
}));

vi.mock("@/lib/import/enml-to-blocknote", () => ({
  convertEnmlToBlocks: (...args: unknown[]) => mockConvert(...args),
}));

const mockUpdate = vi.fn();
const mockEqId = vi.fn();
const mockEqUser = vi.fn();

const mockSupabase = {
  from: vi.fn(() => ({
    update: mockUpdate.mockReturnValue({
      eq: mockEqId.mockReturnValue({ eq: mockEqUser }),
    }),
  })),
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/import/evernote/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/import/evernote/finalize", () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockErrorResponse.mockImplementation(
      (msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status }),
    );
    mockSuccessResponse.mockImplementation(
      (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    );
    mockConvert.mockReturnValue([{ type: "paragraph", content: [] }]);
    mockEqUser.mockResolvedValue({ error: null });
    mockGetNoteOwner.mockResolvedValue({
      data: { user: { id: "user-1" }, supabase: mockSupabase },
      error: null,
    });
    vi.resetModules();
    const mod = await import("@/app/api/import/evernote/finalize/route");
    POST = mod.POST;
  });

  const body: ImportFinalizeRequest = {
    noteId: "note-1",
    content: "<en-note><en-media hash='abc' type='image/png'/></en-note>",
    attachments: [{ md5: "ABC", url: "attachment://user-1/note-1/pic.png", name: "pic.png" }],
    tasks: [],
  };

  it("builds the md5 map (lowercased) and writes converted content", async () => {
    await POST(makeRequest(body));

    expect(mockConvert).toHaveBeenCalledTimes(1);
    const [content, map, tasks] = mockConvert.mock.calls[0];
    expect(content).toBe(body.content);
    expect(tasks).toEqual([]);
    expect(map.get("abc")).toEqual({ url: "attachment://user-1/note-1/pic.png", name: "pic.png" });
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockEqId).toHaveBeenCalledWith("id", "note-1");
    expect(mockEqUser).toHaveBeenCalledWith("user_id", "user-1");
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "note-1" }),
      200,
    );
  });

  it("skips a foreign attachment URL but still writes the note text (no data loss, IDOR-safe)", async () => {
    await POST(
      makeRequest({
        ...body,
        attachments: [
          { md5: "abc", url: "attachment://other-user/note-9/pic.png", name: "pic.png" },
        ],
      }),
    );
    // The smuggled reference is dropped from the map (never reaches saved content)…
    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][1].has("abc")).toBe(false);
    // …but the note's text is still converted and written.
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "note-1" }),
      200,
    );
  });

  it("returns 400 when noteId is missing", async () => {
    await POST(makeRequest({ content: "<en-note></en-note>", attachments: [] }));
    expect(mockErrorResponse).toHaveBeenCalledWith("noteId is required", 400);
  });

  it("returns the auth/ownership error when the note is not owned", async () => {
    mockGetNoteOwner.mockResolvedValue({
      data: null,
      error: new Response(JSON.stringify({ error: "Note not found" }), { status: 404 }),
    });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(404);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("returns 500 when the content update fails", async () => {
    mockEqUser.mockResolvedValue({ error: { message: "db down" } });
    await POST(makeRequest(body));
    expect(mockErrorResponse).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update"),
      500,
    );
  });
});
