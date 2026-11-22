import { describe, expect, it } from "vitest";
import {
  PUBLIC_MCP_METHODS,
  hasApiKey,
  isPublicMcpMessage,
  readJsonRpcBody,
} from "@/lib/api/mcp-public-methods";

const request = (method: string, id: number | undefined = 1) =>
  id === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, id };

describe("isPublicMcpMessage", () => {
  it("allows exactly the handshake, ping and tools/list", () => {
    expect([...PUBLIC_MCP_METHODS].sort()).toEqual([
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
    ]);
  });

  it.each(["initialize", "ping", "tools/list"])("is true for %s alone", (method) => {
    expect(isPublicMcpMessage(request(method))).toBe(true);
  });

  it("is true for the initialized notification", () => {
    expect(isPublicMcpMessage(request("notifications/initialized", undefined))).toBe(true);
  });

  it("is true for a batch in which every message is public", () => {
    expect(
      isPublicMcpMessage([request("notifications/initialized", undefined), request("tools/list")]),
    ).toBe(true);
  });

  it.each([
    ["tools/call", request("tools/call")],
    ["a batch holding a tool call", [request("tools/list"), request("tools/call", 2)]],
    ["another method", request("resources/list")],
    ["an empty batch", []],
    ["a JSON-RPC response", { jsonrpc: "2.0", result: { method: "tools/list" }, id: 1 }],
    ["a method that isn't a string", { jsonrpc: "2.0", method: ["tools/list"], id: 1 }],
    ["null", null],
    ["undefined (a body that isn't JSON)", undefined],
    ["a string", "tools/list"],
    ["a batch holding null", [request("tools/list"), null]],
  ])("is false for %s", (_name, message) => {
    expect(isPublicMcpMessage(message)).toBe(false);
  });
});

describe("hasApiKey", () => {
  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["spaces", "   "],
    ["a bare Bearer", "Bearer"],
    ["Bearer and a space", "Bearer "],
    ["lower-case bearer and spaces", "bearer   "],
  ])("is false for %s", (_name, header) => {
    expect(hasApiKey(header)).toBe(false);
  });

  it.each([
    ["a bearer key", "Bearer dk_abc"],
    ["another scheme, which fails authentication", "Basic dXNlcjpwYXNz"],
    ["a word that only starts with Bearer", "Bearerdk_abc"],
  ])("is true for %s", (_name, header) => {
    expect(hasApiKey(header)).toBe(true);
  });
});

describe("readJsonRpcBody", () => {
  const post = (body: string) => new Request("http://localhost/api/mcp", { method: "POST", body });

  it("reads a clone, leaving the body readable", async () => {
    const body = JSON.stringify(request("tools/call"));
    const req = post(body);

    await expect(readJsonRpcBody(req)).resolves.toEqual(request("tools/call"));
    await expect(req.text()).resolves.toBe(body);
  });

  it("reads a body up to the limit", async () => {
    const body = JSON.stringify(request("tools/list"));

    await expect(readJsonRpcBody(post(body), body.length)).resolves.toEqual(request("tools/list"));
  });

  it("is undefined for a body over the limit, declared or streamed", async () => {
    const body = JSON.stringify(request("tools/list"));
    const declared = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Length": String(body.length) },
      body,
    });
    // A stream has no Content-Length, so the limit is enforced while reading.
    const encoded = new TextEncoder().encode(body);
    const streamed = new Request("http://localhost/api/mcp", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, 10));
          controller.enqueue(encoded.slice(10));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    await expect(readJsonRpcBody(declared, body.length - 1)).resolves.toBeUndefined();
    await expect(readJsonRpcBody(streamed, body.length - 1)).resolves.toBeUndefined();
  });

  it("is undefined for a body that isn't JSON or a body already read", async () => {
    await expect(readJsonRpcBody(post("not json"))).resolves.toBeUndefined();

    const read = post(JSON.stringify(request("tools/call")));
    await read.text();
    await expect(readJsonRpcBody(read)).resolves.toBeUndefined();
  });
});
