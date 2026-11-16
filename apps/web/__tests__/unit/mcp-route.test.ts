import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock env before importing route
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  },
}));

// Mock the MCP auth
vi.mock("@/lib/api/mcp-auth", () => ({
  authenticateMcpRequest: vi.fn(),
}));

// We need to mock the SDK modules so the route can be imported without errors
const mockHandleRequest = vi.fn();
const mockTransportClose = vi.fn();
const mockServerConnect = vi.fn();
const mockServerClose = vi.fn();
const mockTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.tool = mockTool;
    this.connect = mockServerConnect;
    this.close = mockServerClose;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
  ) {
    this.handleRequest = mockHandleRequest;
    this.close = mockTransportClose;
  }),
}));

// after() runs its task once the response is sent; collect the tasks to run them later.
const afterTasks: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
}));
const runAfterTasks = () => Promise.all(afterTasks.splice(0).map((task) => task()));

const mockDeleteNotebook = vi.fn();
vi.mock("@/lib/api/mcp-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/mcp-tools")>()),
  deleteNotebook: (...args: unknown[]) => mockDeleteNotebook(...args),
}));

const mockRemoveUserOrphanedAttachments = vi.fn();
vi.mock("@/lib/storage/remove-orphaned-attachments", () => ({
  removeUserOrphanedAttachments: (...args: unknown[]) => mockRemoveUserOrphanedAttachments(...args),
}));

const { authenticateMcpRequest } = await import("@/lib/api/mcp-auth");
const { POST, GET, DELETE } = await import("@/app/api/mcp/route");

describe("POST /api/mcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleRequest.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 }),
    );
  });

  it("returns 401 when authentication fails", async () => {
    vi.mocked(authenticateMcpRequest).mockRejectedValue(new Error("Invalid API key"));

    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe("Invalid API key");
  });

  it("returns 401 when no Authorization header", async () => {
    vi.mocked(authenticateMcpRequest).mockRejectedValue(
      new Error("Missing or invalid Authorization header"),
    );

    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("processes MCP request when authenticated", async () => {
    const mockFrom = vi.fn();
    vi.mocked(authenticateMcpRequest).mockResolvedValue({
      userId: "user-1",
      supabase: { from: mockFrom } as never,
    });

    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dk_test123",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockServerConnect).toHaveBeenCalled();
    expect(mockHandleRequest).toHaveBeenCalledWith(request);
    expect(mockServerClose).toHaveBeenCalled();
    expect(mockTransportClose).toHaveBeenCalled();
  });

  it("registers 11 MCP tools", async () => {
    const mockFrom = vi.fn();
    vi.mocked(authenticateMcpRequest).mockResolvedValue({
      userId: "user-1",
      supabase: { from: mockFrom } as never,
    });

    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dk_test123",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    await POST(request);

    // Verify all 11 tools are registered
    const toolNames = mockTool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toContain("list_notebooks");
    expect(toolNames).toContain("list_notes");
    expect(toolNames).toContain("read_note");
    expect(toolNames).toContain("search_notes");
    expect(toolNames).toContain("create_notebook");
    expect(toolNames).toContain("create_note");
    expect(toolNames).toContain("update_note");
    expect(toolNames).toContain("move_note");
    expect(toolNames).toContain("trash_note");
    expect(toolNames).toContain("rename_notebook");
    expect(toolNames).toContain("delete_notebook");
    expect(toolNames).toHaveLength(11);
  });

  describe("delete_notebook", () => {
    beforeEach(() => {
      afterTasks.length = 0;
    });

    async function deleteNotebookHandler() {
      vi.mocked(authenticateMcpRequest).mockResolvedValue({
        userId: "user-1",
        supabase: { from: vi.fn() } as never,
      });
      await POST(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer dk_test123" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
        }),
      );
      const call = mockTool.mock.calls.find((c: unknown[]) => c[0] === "delete_notebook");
      if (!call) throw new Error("delete_notebook was not registered");
      return call[3] as (args: { notebook_id: string }) => Promise<{ isError?: boolean }>;
    }

    it("sweeps the user's orphaned files after deleting the notebook", async () => {
      const handler = await deleteNotebookHandler();
      const deleted = { content: [{ type: "text", text: "Notebook deleted." }] };
      mockDeleteNotebook.mockResolvedValue(deleted);

      await expect(handler({ notebook_id: "nb-1" })).resolves.toBe(deleted);
      expect(mockDeleteNotebook).toHaveBeenCalledWith(expect.anything(), "user-1", "nb-1");
      expect(mockRemoveUserOrphanedAttachments).not.toHaveBeenCalled();
      await runAfterTasks();
      expect(mockRemoveUserOrphanedAttachments).toHaveBeenCalledWith("user-1", "web-mcp");
    });

    it("sweeps nothing when the delete is refused", async () => {
      const handler = await deleteNotebookHandler();
      const refused = { content: [{ type: "text", text: "Error" }], isError: true };
      mockDeleteNotebook.mockResolvedValue(refused);

      await expect(handler({ notebook_id: "nb-1" })).resolves.toBe(refused);
      expect(afterTasks).toHaveLength(0);
    });
  });

  it("calls close on server and transport after processing", async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue({
      userId: "user-1",
      supabase: { from: vi.fn() } as never,
    });

    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer dk_test123" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    await POST(request);
    expect(mockServerClose).toHaveBeenCalled();
    expect(mockTransportClose).toHaveBeenCalled();
  });
});

describe("GET /api/mcp", () => {
  it("returns 405", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
  });
});

describe("DELETE /api/mcp", () => {
  it("returns 405", async () => {
    const response = await DELETE();
    expect(response.status).toBe(405);
  });
});
