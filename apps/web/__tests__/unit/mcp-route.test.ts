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

const { mockAfter, mockCaptureException } = vi.hoisted(() => ({
  mockAfter: vi.fn(),
  mockCaptureException: vi.fn(),
}));

// `after` only works inside a Next.js request scope. Capture its callbacks instead, so a test
// can run them (or not) and check they never touch the response. The rest of next/server
// stays real.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mockAfter,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mockCaptureException,
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

describe("POST /api/mcp activity day (ADR 0077)", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  function authenticatedRequest(): Request {
    return new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer dk_test123" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
  }

  function supabaseWithUpsert(upsert: ReturnType<typeof vi.fn>) {
    const from = vi.fn().mockReturnValue({ upsert });
    return { supabase: { from } as never, from };
  }

  async function runAfterCallbacks(): Promise<void> {
    for (const [callback] of mockAfter.mock.calls as [() => unknown][]) await callback();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleRequest.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", result: { tools: [] } }), { status: 200 }),
    );
  });

  it("records (user, today, web-mcp) after the response of an authenticated call", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const { supabase, from } = supabaseWithUpsert(upsert);
    vi.mocked(authenticateMcpRequest).mockResolvedValue({ userId: "user-1", supabase });

    const response = await POST(authenticatedRequest());

    expect(response.status).toBe(200);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    // Scheduled, not run inline: nothing is written while the request is handled.
    expect(upsert).not.toHaveBeenCalled();

    await runAfterCallbacks();

    expect(from).toHaveBeenCalledWith("usage_daily");
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "user-1", day: today(), client: "web-mcp" },
      { onConflict: "user_id,day,client", ignoreDuplicates: true },
    );
  });

  it("records nothing when authentication fails", async () => {
    vi.mocked(authenticateMcpRequest).mockRejectedValue(new Error("Invalid API key"));

    const response = await POST(authenticatedRequest());

    expect(response.status).toBe(401);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("returns the same response when recording the day fails", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: "permission denied" } });
    const { supabase } = supabaseWithUpsert(upsert);
    vi.mocked(authenticateMcpRequest).mockResolvedValue({ userId: "user-1", supabase });
    // Run the callback as soon as it is scheduled, so the failure happens mid-request.
    let recording: unknown;
    mockAfter.mockImplementationOnce((callback: () => unknown) => {
      recording = callback();
    });

    const response = await POST(authenticatedRequest());
    await recording;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", result: { tools: [] } });
    expect(upsert).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it("returns the same response when the recording request rejects", async () => {
    const upsert = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const { supabase } = supabaseWithUpsert(upsert);
    vi.mocked(authenticateMcpRequest).mockResolvedValue({ userId: "user-1", supabase });

    const response = await POST(authenticatedRequest());

    await expect(runAfterCallbacks()).resolves.toBeUndefined();
    expect(response.status).toBe(200);
    expect(mockCaptureException).toHaveBeenCalled();
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
