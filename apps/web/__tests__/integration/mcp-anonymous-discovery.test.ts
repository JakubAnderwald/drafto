/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real MCP SDK serves these requests; only what needs a deployment is stubbed. A key-less
// request must never reach the database, so the auth module is spied on, not replaced.
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: undefined,
  },
}));

const { mockAfter } = vi.hoisted(() => ({ mockAfter: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mockAfter,
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const mcpAuth = await import("@/lib/api/mcp-auth");
const authSpy = vi.spyOn(mcpAuth, "authenticateMcpRequest");
const { POST } = await import("@/app/api/mcp/route");

function keyless(body: unknown): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mcp without an API key (ADR 0095)", () => {
  beforeEach(() => {
    authSpy.mockClear();
    mockAfter.mockClear();
  });

  it("answers initialize with Drafto's name, website, icon and how to get a key", async () => {
    const response = await POST(
      keyless({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "directory-probe", version: "1.0.0" },
        },
      }),
    );

    expect(response.status).toBe(200);
    const { result } = (await response.json()) as {
      result: {
        serverInfo: { name: string; title: string; websiteUrl: string; icons: { src: string }[] };
        capabilities: { tools?: unknown };
        instructions: string;
      };
    };
    expect(result.serverInfo).toMatchObject({
      name: "drafto",
      title: "Drafto",
      websiteUrl: "https://drafto.eu",
    });
    expect(result.serverInfo.icons[0]?.src).toBe("https://drafto.eu/mcp-icon.png");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toContain("drafto.eu/settings");
    expect(authSpy).not.toHaveBeenCalled();
  });

  it("lists all 11 tools with their input schemas", async () => {
    const response = await POST(keyless({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

    expect(response.status).toBe(200);
    const { result } = (await response.json()) as {
      result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] };
    };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_note",
      "create_notebook",
      "delete_notebook",
      "list_notebooks",
      "list_notes",
      "move_note",
      "read_note",
      "rename_notebook",
      "search_notes",
      "trash_note",
      "update_note",
    ]);
    const readNote = result.tools.find((t) => t.name === "read_note");
    expect(Object.keys(readNote?.inputSchema.properties ?? {})).toEqual(["note_id"]);
    expect(authSpy).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("answers ping", async () => {
    const response = await POST(keyless({ jsonrpc: "2.0", id: 3, method: "ping" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("refuses a tool call with a 401 before any tool runs", async () => {
    const response = await POST(
      keyless({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_notebooks", arguments: {} },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: expect.stringContaining("drafto.eu/settings") },
      id: null,
    });
    expect(authSpy).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("still refuses a bad key, even for tools/list", async () => {
    const request = keyless({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    request.headers.set("Authorization", "Bearer dk_wrong");

    const response = await POST(request);

    // No service-role key in this test, so authentication fails before any lookup.
    expect(response.status).toBe(401);
    // Also proves the spy sees the route's calls, so the not-called checks above mean something.
    expect(authSpy).toHaveBeenCalledWith("Bearer dk_wrong");
  });
});
