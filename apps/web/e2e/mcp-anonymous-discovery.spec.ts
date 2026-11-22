import { test, expect } from "@playwright/test";

/**
 * `/api/mcp` without an API key (ADR 0095). A client or a directory such as the MCP Registry's
 * listing sites can run the handshake and `tools/list` to see what Drafto offers; calling a
 * tool still needs `Authorization: Bearer <key>`.
 */

// An MCP client sends no Drafto cookie, so neither do these requests.
test.use({ storageState: { cookies: [], origins: [] } });

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

test.describe("MCP server without a key", () => {
  test("initialize names the server, its website and icon", async ({ request }) => {
    const response = await request.post("/api/mcp", {
      headers: MCP_HEADERS,
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "e2e-probe", version: "1.0.0" },
        },
      },
    });

    expect(response.status()).toBe(200);
    const { result } = await response.json();
    expect(result.serverInfo).toMatchObject({
      name: "drafto",
      title: "Drafto",
      websiteUrl: "https://drafto.eu",
    });
  });

  test("tools/list returns all 11 tools", async ({ request }) => {
    const response = await request.post("/api/mcp", {
      headers: MCP_HEADERS,
      data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });

    expect(response.status()).toBe(200);
    const { result } = await response.json();
    expect(result.tools).toHaveLength(11);
    expect(result.tools.map((t: { name: string }) => t.name)).toContain("read_note");
  });

  test("tools/call is refused with a 401", async ({ request }) => {
    const response = await request.post("/api/mcp", {
      headers: MCP_HEADERS,
      data: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_notebooks", arguments: {} },
      },
    });

    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe(-32000);
  });

  test("a bad key is refused even for tools/list", async ({ request }) => {
    const response = await request.post("/api/mcp", {
      headers: { ...MCP_HEADERS, Authorization: "Bearer dk_not-a-real-key" },
      data: { jsonrpc: "2.0", id: 4, method: "tools/list" },
    });

    expect(response.status()).toBe(401);
  });

  test("the registry icon is served as a PNG", async ({ request }) => {
    const response = await request.get("/mcp-icon.png", { maxRedirects: 0 });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  });

  test("the mcptry claim file is served signed out as plain text", async ({ request }) => {
    const response = await request.get("/.well-known/mcptry-verify.txt", { maxRedirects: 0 });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^text\/plain/);
    expect(await response.text()).toMatch(/^mcptry-verify=\S+$/m);
  });
});
