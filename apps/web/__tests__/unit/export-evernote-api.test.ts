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

const tableCalls: Record<string, Array<{ method: string; args: unknown[] }>> = {};

let tableState: TableState = {};
const downloadMock = vi.fn();

function makeQueryBuilder(table: string) {
  const finalResultByTable: Record<string, { data: unknown; error: unknown }> = {
    notebooks: tableState.notebooks ?? { data: [], error: null },
    notes: tableState.notes ?? { data: [], error: null },
    attachments: tableState.attachments ?? { data: [], error: null },
  };

  const calls = (tableCalls[table] ??= []);
  const builder: Record<string, unknown> = {
    _calls: calls,
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
    for (const key of Object.keys(tableCalls)) delete tableCalls[key];

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

  it("returns 404 when only some requested notebooks are owned", async () => {
    // Defence-in-depth: RLS already hides foreign rows, but a mixed selection
    // must fail rather than silently exporting just the owned subset.
    tableState = {
      notebooks: { data: [{ id: "nb-owned", name: "Owned" }], error: null },
    };
    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["nb-owned", "nb-foreign"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns 500 when a storage attachment download fails", async () => {
    downloadMock.mockResolvedValueOnce({ data: null, error: { message: "storage offline" } });

    tableState = {
      notebooks: { data: [{ id: "nb-1", name: "Photos" }], error: null },
      notes: {
        data: [
          {
            id: "note-1",
            notebook_id: "nb-1",
            title: "Photo",
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
            file_size: 5,
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
    expect(res.status).toBe(500);
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

  it("returns 500 when the notebooks query errors", async () => {
    tableState = {
      notebooks: { data: null, error: { message: "db down" } },
    };
    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookIds: ["nb-1"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const req = new NextRequest("http://localhost/api/export/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns a zip containing one .enex per notebook for multi-notebook exports", async () => {
    // Evernote's ENEX format is single-notebook on import. To preserve notebook
    // boundaries we ship a zip of per-notebook .enex files for multi-notebook
    // selections, mirroring what Evernote itself produces.
    tableState = {
      notebooks: {
        data: [
          { id: "nb-1", name: "Alpha" },
          { id: "nb-2", name: "Beta" },
        ],
        error: null,
      },
      notes: {
        data: [
          {
            id: "note-1",
            notebook_id: "nb-1",
            title: "n1",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "from-alpha", styles: {} }] },
            ],
            created_at: "2026-06-08T14:02:14Z",
            updated_at: "2026-06-08T14:02:14Z",
          },
          {
            id: "note-2",
            notebook_id: "nb-2",
            title: "n2",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "from-beta", styles: {} }] },
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
      body: JSON.stringify({ notebookIds: ["nb-1", "nb-2"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toMatch(/drafto-export-\d{4}-\d{2}-\d{2}\.zip/);

    const buffer = new Uint8Array(await res.arrayBuffer());
    // ZIP local-file-header signature ("PK\x03\x04") at offset 0.
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
    expect(buffer[2]).toBe(0x03);
    expect(buffer[3]).toBe(0x04);

    // Filenames in local-file headers — assert one entry per notebook.
    const decoded = new TextDecoder("latin1").decode(buffer);
    expect(decoded).toContain("Alpha.enex");
    expect(decoded).toContain("Beta.enex");
    // Each ENEX body must include its own note's content (notes weren't merged).
    expect(decoded).toContain("from-alpha");
    expect(decoded).toContain("from-beta");
  });

  it("skips selected notebooks that have no notes when packaging the zip", async () => {
    tableState = {
      notebooks: {
        data: [
          { id: "nb-1", name: "Has notes" },
          { id: "nb-2", name: "Empty" },
        ],
        error: null,
      },
      notes: {
        data: [
          {
            id: "note-1",
            notebook_id: "nb-1",
            title: "n1",
            content: [{ type: "paragraph", content: [{ type: "text", text: "x", styles: {} }] }],
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
    // Only one notebook ends up with notes → fall back to a single .enex
    // instead of a one-entry zip, so the file extension matches the content.
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/enex+xml");
    expect(res.headers.get("Content-Disposition")).toContain("Has-notes.enex");
  });
});

describe("GET /api/export/evernote", () => {
  let GET: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tableState = {};
    for (const key of Object.keys(tableCalls)) delete tableCalls[key];

    mockErrorResponse.mockImplementation(
      (msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status }),
    );
    mockGetAuthenticatedUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" }, supabase: mockSupabase },
      error: null,
    });

    vi.resetModules();
    const mod = await import("@/app/api/export/evernote/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAuthenticatedUser.mockResolvedValue({
      data: null,
      error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });
    const req = new NextRequest("http://localhost/api/export/evernote");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns notebooks with note counts derived from a single notes query", async () => {
    tableState = {
      notebooks: {
        data: [
          { id: "nb-1", name: "Inbox" },
          { id: "nb-2", name: "Empty" },
          { id: "nb-3", name: "Archive" },
        ],
        error: null,
      },
      notes: {
        data: [
          { notebook_id: "nb-1" },
          { notebook_id: "nb-1" },
          { notebook_id: "nb-1" },
          { notebook_id: "nb-3" },
        ],
        error: null,
      },
    };

    const req = new NextRequest("http://localhost/api/export/evernote");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notebooks: Array<{ id: string; name: string; noteCount: number }>;
    };
    expect(body.notebooks).toEqual([
      { id: "nb-1", name: "Inbox", noteCount: 3 },
      { id: "nb-2", name: "Empty", noteCount: 0 },
      { id: "nb-3", name: "Archive", noteCount: 1 },
    ]);

    // Single notes query, not one per notebook — guards against an N+1 regression.
    const notesQueries = (tableCalls.notes ?? []).filter((c) => c.method === "select");
    expect(notesQueries).toHaveLength(1);
  });

  it("returns 500 when the notebooks query errors", async () => {
    tableState = {
      notebooks: { data: null, error: { message: "db down" } },
    };
    const req = new NextRequest("http://localhost/api/export/evernote");
    const res = await GET(req);
    expect(res.status).toBe(500);
  });

  it("returns 500 when the notes count query errors", async () => {
    tableState = {
      notebooks: { data: [{ id: "nb-1", name: "Inbox" }], error: null },
      notes: { data: null, error: { message: "boom" } },
    };
    const req = new NextRequest("http://localhost/api/export/evernote");
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});
