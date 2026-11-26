import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const { mockReportError } = vi.hoisted(() => ({ mockReportError: vi.fn() }));
vi.mock("@/lib/report-error", () => ({ reportError: mockReportError }));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockCreateSignedUrls = vi.fn().mockResolvedValue({ data: [], error: null });
type SignedUrlResult = {
  data: { signedUrl: string } | null;
  error: { message: string } | null;
};
const signedUrlOk = (): Promise<SignedUrlResult> =>
  Promise.resolve({ data: { signedUrl: "https://signed.test/url" }, error: null });
const mockCreateSignedUrl = vi.fn<(filePath: string) => Promise<SignedUrlResult>>(signedUrlOk);

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    storage: {
      from: () => ({
        createSignedUrl: mockCreateSignedUrl,
        createSignedUrls: mockCreateSignedUrls,
      }),
    },
  }),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

const approvedProfile = {
  select: () => ({
    eq: () => ({
      single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
    }),
  }),
};

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

const params = Promise.resolve({ id: "note-1" });

describe("Notes API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSignedUrl.mockImplementation(signedUrlOk);
  });

  describe("GET /api/notes/[id]", () => {
    it("returns 401 when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });
      expect(response.status).toBe(401);
    });

    it("returns note data", async () => {
      authenticateAs("user-1");
      const note = { id: "note-1", title: "Test", content: null };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
        };
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("Test");
    });

    it("converts TipTap content to BlockNote format on read", async () => {
      authenticateAs("user-1");
      const tiptapContent = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      };
      const note = { id: "note-1", title: "Test", content: tiptapContent };
      const mockUpdate = vi.fn().mockReturnValue({
        eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
      });
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
          update: mockUpdate,
        };
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      // Should be converted to BlockNote array format
      expect(Array.isArray(body.content)).toBe(true);
      expect(body.content[0].type).toBe("paragraph");
      // Should persist the conversion back to DB with BlockNote content
      expect(mockUpdate).toHaveBeenCalledWith({
        content: expect.arrayContaining([expect.objectContaining({ type: "paragraph" })]),
      });
    });

    it("resolves attachment:// URLs in content to signed URLs", async () => {
      authenticateAs("user-1");
      const content = [
        {
          type: "image",
          props: { url: "attachment://user-1/note-1/img.jpg" },
          children: [],
        },
      ];
      const note = { id: "note-1", title: "Test", content };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
        };
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.content[0].props.url).toBe("https://signed.test/url");
    });

    it("reports a failed write of the converted content, with the note id", async () => {
      authenticateAs("user-1");
      const tiptapContent = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      };
      const note = { id: "note-1", title: "Test", content: tiptapContent };
      const updateError = { message: "update failed" };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({ eq: () => Promise.resolve({ error: updateError }) }),
          }),
        };
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });

      // The write is fire-and-forget: the read still succeeds with the converted content.
      expect(response.status).toBe(200);
      expect(Array.isArray((await response.json()).content)).toBe(true);
      await vi.waitFor(() =>
        expect(mockReportError).toHaveBeenCalledWith(
          updateError,
          "api:notes-get:persist-converted",
          { extra: { noteId: "note-1" } },
        ),
      );
    });

    it("reports attachment signing failures once per request, without file paths", async () => {
      authenticateAs("user-1");
      const content = [
        { type: "image", props: { url: "attachment://user-1/note-1/a.jpg" }, children: [] },
        { type: "image", props: { url: "attachment://user-1/note-1/b.jpg" }, children: [] },
        { type: "image", props: { url: "attachment://user-1/note-1/c.jpg" }, children: [] },
      ];
      const note = { id: "note-1", title: "Test", content };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
        };
      });
      const signError = { message: "Object not found" };
      mockCreateSignedUrl.mockImplementation((filePath: string) =>
        filePath.endsWith("b.jpg")
          ? signedUrlOk()
          : Promise.resolve({ data: null, error: signError }),
      );

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });

      // Unchanged response: a failed image keeps its attachment:// URL, the others are signed.
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.content.map((block: { props: { url: string } }) => block.props.url)).toEqual([
        "attachment://user-1/note-1/a.jpg",
        "https://signed.test/url",
        "attachment://user-1/note-1/c.jpg",
      ]);

      expect(mockReportError).toHaveBeenCalledOnce();
      expect(mockReportError).toHaveBeenCalledWith(signError, "api:notes-get:sign-attachments", {
        extra: { noteId: "note-1", failedCount: 2 },
      });
      expect(JSON.stringify(mockReportError.mock.calls)).not.toContain("jpg");
    });

    it("reports a signing call that returns no URL", async () => {
      authenticateAs("user-1");
      const content = [
        { type: "image", props: { url: "attachment://user-1/note-1/a.jpg" }, children: [] },
      ];
      const note = { id: "note-1", title: "Test", content };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
        };
      });
      mockCreateSignedUrl.mockImplementation(() => Promise.resolve({ data: null, error: null }));

      const { GET } = await import("@/app/api/notes/[id]/route");
      const response = await GET(new NextRequest("http://localhost:3000/api/notes/note-1"), {
        params,
      });

      expect(response.status).toBe(200);
      expect(mockReportError).toHaveBeenCalledOnce();
      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        "api:notes-get:sign-attachments",
        { extra: { noteId: "note-1", failedCount: 1 } },
      );
    });

    it("does not report when every attachment is signed", async () => {
      authenticateAs("user-1");
      const content = [
        { type: "image", props: { url: "attachment://user-1/note-1/a.jpg" }, children: [] },
      ];
      const note = { id: "note-1", title: "Test", content };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
        };
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const response = await GET(new NextRequest("http://localhost:3000/api/notes/note-1"), {
        params,
      });

      expect(response.status).toBe(200);
      expect(mockReportError).not.toHaveBeenCalled();
    });

    it("returns is_trashed so the editor can see a note trashed on another device", async () => {
      // Deliberately selected rather than filtered on: the web editor keeps a trashed
      // note open (its edits are still recoverable) and needs to say so.
      authenticateAs("user-1");
      const selectedColumns = vi.fn();
      const note = {
        id: "note-1",
        title: "Trashed elsewhere",
        content: null,
        is_trashed: true,
        created_at: "2026-09-06T10:00:00.000+00:00",
        updated_at: "2026-09-06T12:05:00.000+00:00",
      };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: (columns: string) => {
            selectedColumns(columns);
            return {
              eq: () => ({
                eq: () => ({
                  single: () => Promise.resolve({ data: note, error: null }),
                }),
              }),
            };
          },
        };
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });

      expect(response.status).toBe(200);
      expect(selectedColumns).toHaveBeenCalledWith(expect.stringContaining("is_trashed"));
      expect(await response.json()).toMatchObject({
        is_trashed: true,
        updated_at: note.updated_at,
      });
    });
  });

  describe("PATCH /api/notes/[id]", () => {
    function mockUpdateResult(result: { data: unknown; error: unknown }) {
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({ single: () => Promise.resolve(result) }),
              }),
            }),
          }),
        };
      });
    }

    function patchContent() {
      return new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ content: [{ type: "paragraph", content: [] }] }),
        headers: { "Content-Type": "application/json" },
      });
    }

    it("answers 413 with the usage when the content quota refuses the save", async () => {
      authenticateAs("user-1");
      mockUpdateResult({
        data: null,
        error: {
          code: "P0001",
          message: "content_quota_exceeded",
          details: "used_bytes=100 quota_bytes=200 note_bytes=150",
        },
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const response = await PATCH(patchContent(), { params });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "Note content quota exceeded",
        code: "content_quota_exceeded",
        usedBytes: 100,
        quotaBytes: 200,
        status: 413,
      });
    });

    it("still answers 404 for any other update failure", async () => {
      authenticateAs("user-1");
      mockUpdateResult({ data: null, error: { code: "PGRST116", message: "no rows" } });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const response = await PATCH(patchContent(), { params });
      expect(response.status).toBe(404);
    });

    it("updates note title", async () => {
      authenticateAs("user-1");
      const updated = { id: "note-1", title: "Updated" };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: () => Promise.resolve({ data: updated, error: null }),
                }),
              }),
            }),
          }),
        };
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(200);
    });

    it("updates note notebook_id (move between notebooks)", async () => {
      authenticateAs("user-1");
      const updated = { id: "note-1", title: "Test", notebook_id: "nb-2" };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: () => Promise.resolve({ data: updated, error: null }),
                }),
              }),
            }),
          }),
        };
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ notebook_id: "nb-2" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notebook_id).toBe("nb-2");
    });

    it("migrates signed Supabase URLs to attachment:// on content save", async () => {
      authenticateAs("user-1");
      const content = [
        {
          type: "image",
          props: {
            url: "https://abc.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/img.jpg?token=xyz",
          },
          children: [],
        },
      ];
      const mockUpdate = vi.fn().mockReturnValue({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: "note-1", content },
                  error: null,
                }),
            }),
          }),
        }),
      });
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return { update: mockUpdate };
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ content }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(200);

      // The content saved should have the migrated attachment:// URL
      const savedContent = mockUpdate.mock.calls[0][0].content;
      expect(savedContent[0].props.url).toBe("attachment://user-1/note-1/img.jpg");
    });

    it("maps a native app's device-local image src back to attachment:// (ADR-0086)", async () => {
      authenticateAs("user-1");
      const content = [
        {
          type: "image",
          props: {
            url: "file:///data/user/0/eu.drafto.mobile/files/attachment-cache/user-1/note-1/img.jpg#drafto-attachment=user-1%2Fnote-1%2Fimg.jpg",
          },
          children: [],
        },
      ];
      const mockUpdate = vi.fn().mockReturnValue({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: "note-1", content }, error: null }),
            }),
          }),
        }),
      });
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return { update: mockUpdate };
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ content }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(200);

      const savedContent = mockUpdate.mock.calls[0][0].content;
      expect(savedContent[0].props.url).toBe("attachment://user-1/note-1/img.jpg");
      expect(JSON.stringify(savedContent)).not.toContain("file://");
    });

    it("returns 400 when no fields provided", async () => {
      authenticateAs("user-1");
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {};
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(400);
    });
  });

  describe("DELETE /api/notes/[id]", () => {
    it("soft deletes a note", async () => {
      authenticateAs("user-1");
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        };
      });

      const { DELETE } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params });
      expect(response.status).toBe(200);
    });
  });
});
