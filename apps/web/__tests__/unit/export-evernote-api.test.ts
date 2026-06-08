import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthenticatedUser = vi.fn();
const mockErrorResponse = vi.fn();

vi.mock("@/lib/api/utils", () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
  getAuthenticatedUserFast: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
  errorResponse: (...args: unknown[]) => mockErrorResponse(...args),
  successResponse: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
}));

interface TableState {
  notebooks?: { data: unknown; error: unknown };
  notes?: { data: unknown; error: unknown };
  attachments?: { data: unknown; error: unknown };
  notebooksHead?: { count: number };
}

let tableState: TableState = {};
const downloadMock = vi.fn();

function makeQueryBuilder(table: string) {
  const finalResultByTable: Record<string, { data: unknown; error: unknown }> = {
    notebooks: tableState.notebooks ?? { data: [], error: null },
    notes: tableState.notes ?? { data: [], error: null },
    attachments: tableState.attachments ?? { data: [], error: null },
  };

  const builder: Record<string, unknown> = {
    _calls: [] as Array<{ method: string; args: unknown[] }>,
    _isHead: false,
  };

  const proxy: ProxyHandler<typeof builder> = {
    get(target, prop, receiver) {
      if (prop === "then") {
        // Awaiting the builder resolves to the appropriate final result.
        return (resolve: (v: unknown) => unknown) => {
          if (target._isHead && table === "notes") {
            resolve({ count: tableState.notebooksHead?.count ?? 0, error: null });
          } else {
            resolve(finalResultByTable[table] ?? { data: [], error: null });
          }
        };
      }
      if (typeof prop === "string") {
        return (...args: unknown[]) => {
          (target._calls as Array<{ method: string; args: unknown[] }>).push({
            method: prop,
            args,
          });
          if (prop === "select" && args[1] && typeof args[1] === "object") {
            const opts = args[1] as { head?: boolean };
            if (opts.head) target._isHead = true;
          }
          return receiver;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  };

  return new Proxy(builder, proxy);
}

const mockSupabase = {
  from: vi.fn((table: string) => makeQueryBuilder(table)),
  storage: {
    from: vi.fn(() => ({
      download: downloadMock,
    })),
  },
};

describe("POST /api/export/evernote", () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tableState = {};

    mockErrorResponse.mockImplementation(
      (msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status }),
    );

    mockGetAuthenticatedUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" }, supabase: mockSupabase },
      error: null,
    });

    vi.resetModules();
    const mod = await import("@/app/api/export/evernote/route");
    POST = mod.POST;
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAuthenticatedUser.mockResolvedValue({
      data: null,
      error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["nb-1"] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when notebookIds is missing or empty", async () => {
    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when no owned notebooks match", async () => {
    tableState = { notebooks: { data: [], error: null } };
    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["foreign-nb"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns 404 when notebooks exist but contain no notes", async () => {
    tableState = {
      notebooks: { data: [{ id: "nb-1", name: "Inbox" }], error: null },
      notes: { data: [], error: null },
    };
    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["nb-1"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns a valid .enex file with the correct headers for a single notebook", async () => {
    tableState = {
      notebooks: { data: [{ id: "nb-1", name: "My Notebook" }], error: null },
      notes: {
        data: [
          {
            id: "note-1",
            notebook_id: "nb-1",
            title: "Hello",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Hello world", styles: {} }] },
            ],
            created_at: "2026-06-08T14:02:14Z",
            updated_at: "2026-06-08T14:02:14Z",
          },
        ],
        error: null,
      },
      attachments: { data: [], error: null },
    };

    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["nb-1"] }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/enex+xml");
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("My-Notebook.enex");

    const body = await res.text();
    expect(body).toContain('<?xml version="1.0"');
    expect(body).toContain("<en-export");
    expect(body).toContain("<title>Hello</title>");
    expect(body).toContain("<div>Hello world</div>");
  });

  it("emits matching <en-media hash> and <resource> for each attachment", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    downloadMock.mockResolvedValueOnce({
      data: { arrayBuffer: async () => bytes.buffer },
      error: null,
    });

    tableState = {
      notebooks: { data: [{ id: "nb-1", name: "Photos" }], error: null },
      notes: {
        data: [
          {
            id: "note-1",
            notebook_id: "nb-1",
            title: "Photo note",
            content: [{ type: "image", props: { url: "attachment://user-1/note-1/photo.png" } }],
            created_at: "2026-06-08T14:02:14Z",
            updated_at: "2026-06-08T14:02:14Z",
          },
        ],
        error: null,
      },
      attachments: {
        data: [
          {
            id: "att-1",
            note_id: "note-1",
            file_name: "photo.png",
            file_path: "user-1/note-1/photo.png",
            file_size: bytes.length,
            mime_type: "image/png",
          },
        ],
        error: null,
      },
    };

    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["nb-1"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.text();

    const enMedia = body.match(/<en-media\b[^>]*hash="([^"]+)"/);
    expect(enMedia?.[1]).toMatch(/^[a-f0-9]{32}$/);
    expect(body).toContain(`hash="${enMedia?.[1]}"`);
    expect(body).toContain("<mime>image/png</mime>");
    expect(body).toContain("<file-name>photo.png</file-name>");
  });

  it("returns 413 when total attachment bytes exceed the cap", async () => {
    const oversize = 201 * 1024 * 1024;
    tableState = {
      notebooks: { data: [{ id: "nb-1", name: "Heavy" }], error: null },
      notes: {
        data: [
          {
            id: "note-1",
            notebook_id: "nb-1",
            title: "Heavy",
            content: [],
            created_at: "2026-06-08T14:02:14Z",
            updated_at: "2026-06-08T14:02:14Z",
          },
        ],
        error: null,
      },
      attachments: {
        data: [
          {
            id: "att-1",
            note_id: "note-1",
            file_name: "big.bin",
            file_path: "user-1/note-1/big.bin",
            file_size: oversize,
            mime_type: "application/octet-stream",
          },
        ],
        error: null,
      },
    };

    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["nb-1"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("falls back to drafto-export-<date>.enex for multi-notebook exports", async () => {
    tableState = {
      notebooks: {
        data: [
          { id: "nb-1", name: "A" },
          { id: "nb-2", name: "B" },
        ],
        error: null,
      },
      notes: {
        data: [
          {
            id: "note-1",
            notebook_id: "nb-1",
            title: "n1",
            content: [],
            created_at: "2026-06-08T14:02:14Z",
            updated_at: "2026-06-08T14:02:14Z",
          },
        ],
        error: null,
      },
      attachments: { data: [], error: null },
    };

    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["nb-1", "nb-2"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/drafto-export-\d{4}-\d{2}-\d{2}\.enex/);
  });
});
