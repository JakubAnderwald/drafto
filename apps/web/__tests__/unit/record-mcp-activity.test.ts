import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const { mockCaptureException } = vi.hoisted(() => ({ mockCaptureException: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({
  captureException: mockCaptureException,
}));

const { isMcpToolCall, isMcpToolCallRequest, recordMcpActivity } =
  await import("@/lib/api/record-mcp-activity");

function clientWithUpsert(upsert: ReturnType<typeof vi.fn>) {
  const from = vi.fn().mockReturnValue({ upsert });
  return { client: { from } as unknown as SupabaseClient<Database>, from };
}

describe("isMcpToolCall", () => {
  const toolCall = { jsonrpc: "2.0", method: "tools/call", params: { name: "read_note" }, id: 1 };

  it("is true for a tool call, alone or in a batch", () => {
    expect(isMcpToolCall(toolCall)).toBe(true);
    expect(isMcpToolCall([{ jsonrpc: "2.0", method: "tools/list", id: 1 }, toolCall])).toBe(true);
  });

  it("is false for the handshake, tools/list and anything that isn't a request", () => {
    expect(isMcpToolCall({ jsonrpc: "2.0", method: "initialize", id: 1 })).toBe(false);
    expect(isMcpToolCall({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(false);
    expect(isMcpToolCall({ jsonrpc: "2.0", method: "tools/list", id: 1 })).toBe(false);
    expect(isMcpToolCall([])).toBe(false);
    expect(isMcpToolCall([null, "tools/call", 1])).toBe(false);
    expect(isMcpToolCall(null)).toBe(false);
    expect(isMcpToolCall("tools/call")).toBe(false);
    expect(isMcpToolCall({ jsonrpc: "2.0", result: { method: "tools/call" }, id: 1 })).toBe(false);
  });
});

describe("isMcpToolCallRequest", () => {
  const post = (body: string) => new Request("http://localhost/api/mcp", { method: "POST", body });

  it("reads a clone, leaving the body readable", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1 });
    const request = post(body);

    await expect(isMcpToolCallRequest(request)).resolves.toBe(true);
    await expect(request.text()).resolves.toBe(body);
  });

  it("is false for a body that isn't JSON or a body already read", async () => {
    await expect(isMcpToolCallRequest(post("not json"))).resolves.toBe(false);

    const read = post(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1 }));
    await read.text();
    await expect(isMcpToolCallRequest(read)).resolves.toBe(false);
  });
});

describe("recordMcpActivity", () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
  });

  it("upserts the user's web-mcp row for the UTC day, leaving an existing row alone", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const { client, from } = clientWithUpsert(upsert);

    // 23:30 in New York on the 13th is already the 14th in UTC.
    await recordMcpActivity(client, "user-1", new Date("2026-11-13T23:30:00-05:00"));

    expect(from).toHaveBeenCalledWith("usage_daily");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "user-1", day: "2026-11-14", client: "web-mcp" },
      { onConflict: "user_id,day,client", ignoreDuplicates: true },
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("defaults to today", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const { client } = clientWithUpsert(upsert);
    const today = new Date().toISOString().slice(0, 10);

    await recordMcpActivity(client, "user-1");

    expect(upsert.mock.calls[0][0]).toEqual({ user_id: "user-1", day: today, client: "web-mcp" });
  });

  it("reports an error the database returns to Sentry and resolves", async () => {
    const error = { message: 'relation "usage_daily" does not exist', code: "42P01" };
    const upsert = vi.fn().mockResolvedValue({ error });
    const { client } = clientWithUpsert(upsert);

    await expect(recordMcpActivity(client, "user-1")).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ extra: { where: "record-mcp-activity" } }),
    );
  });

  it("reports a rejected request to Sentry and resolves", async () => {
    const failure = new Error("fetch failed");
    const upsert = vi.fn().mockRejectedValue(failure);
    const { client } = clientWithUpsert(upsert);

    await expect(recordMcpActivity(client, "user-1")).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything());
  });

  it("never throws, even when the client itself throws", async () => {
    const client = {
      from: () => {
        throw new TypeError("client is broken");
      },
    } as unknown as SupabaseClient<Database>;

    await expect(recordMcpActivity(client, "user-1")).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
