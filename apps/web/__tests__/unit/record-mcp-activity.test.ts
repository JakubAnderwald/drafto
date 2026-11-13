import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const { mockCaptureException } = vi.hoisted(() => ({ mockCaptureException: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({
  captureException: mockCaptureException,
}));

const { recordMcpActivity } = await import("@/lib/api/record-mcp-activity");

function clientWithUpsert(upsert: ReturnType<typeof vi.fn>) {
  const from = vi.fn().mockReturnValue({ upsert });
  return { client: { from } as unknown as SupabaseClient<Database>, from };
}

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
