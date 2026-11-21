import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SECRET = "s".repeat(40);
const mockEnv: { HOSTED_USAGE_SECRET: string | undefined } = { HOSTED_USAGE_SECRET: SECRET };
vi.mock("@/env", () => ({
  env: {
    get HOSTED_USAGE_SECRET() {
      return mockEnv.HOSTED_USAGE_SECRET;
    },
  },
}));

const mockInsert = vi.fn();
const mockFrom = vi.fn(() => ({ insert: mockInsert }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => mockCreateAdminClient(...args),
}));

const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

const { POST } = await import("@/app/api/cron/hosted-usage/route");

const READOUT = {
  readings: [
    {
      resource: "vercel_active_cpu",
      used: 2.2833,
      periodFrom: "2026-10-22",
      periodTo: "2026-11-21",
    },
    { resource: "supabase_egress", used: 0.42 },
  ],
};

function request(body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  return new NextRequest("http://localhost:3000/api/cron/hosted-usage", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(auth === null ? {} : { Authorization: auth }),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.HOSTED_USAGE_SECRET = SECRET;
  mockInsert.mockResolvedValue({ error: null });
  mockCreateAdminClient.mockReturnValue({ from: mockFrom });
});

describe("POST /api/cron/hosted-usage", () => {
  it("stores a readout as one row per reading", async () => {
    const res = await POST(request(READOUT));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ inserted: 2 });
    expect(mockCreateAdminClient).toHaveBeenCalledWith("web-cron");
    expect(mockFrom).toHaveBeenCalledWith("hosted_usage_snapshots");
    expect(mockInsert).toHaveBeenCalledWith([
      {
        resource: "vercel_active_cpu",
        used: 2.2833,
        period_from: "2026-10-22",
        period_to: "2026-11-21",
      },
      { resource: "supabase_egress", used: 0.42, period_from: null, period_to: null },
    ]);
  });

  it.each([
    ["no Authorization header", null],
    ["a wrong secret", `Bearer ${"x".repeat(40)}`],
    ["the secret without Bearer", SECRET],
  ])("refuses %s with 401 and stores nothing", async (_name, auth) => {
    const res = await POST(request(READOUT, auth));

    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("answers 500 and reports when the secret isn't configured", async () => {
    mockEnv.HOSTED_USAGE_SECRET = undefined;

    const res = await POST(request(READOUT));

    expect(res.status).toBe(500);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("HOSTED_USAGE_SECRET is not set"),
      "error",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each([
    ["a body that isn't JSON", "{"],
    ["no readings", { readings: [] }],
    ["an unknown resource", { readings: [{ resource: "vercel_builds", used: 1 }] }],
    ["a negative reading", { readings: [{ resource: "vercel_cdn_requests", used: -1 }] }],
    ["an implausible reading", { readings: [{ resource: "vercel_active_cpu", used: 1e6 }] }],
    [
      "a resource twice",
      {
        readings: [
          { resource: "supabase_egress", used: 1 },
          { resource: "supabase_egress", used: 2 },
        ],
      },
    ],
    [
      "a reversed period",
      {
        readings: [
          {
            resource: "supabase_egress",
            used: 1,
            periodFrom: "2026-11-21",
            periodTo: "2026-10-22",
          },
        ],
      },
    ],
    ["an extra field", { readings: [{ resource: "supabase_egress", used: 1, note: "x" }] }],
    [
      "an impossible date",
      { readings: [{ resource: "supabase_egress", used: 1, periodTo: "2026-02-30" }] },
    ],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await POST(request(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^(Body must be JSON|Invalid readout)/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("answers 500 when the service-role client can't be built", async () => {
    mockCreateAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
    });

    const res = await POST(request(READOUT));

    expect(res.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it("answers 500 and reports a failed insert", async () => {
    mockInsert.mockResolvedValue({ error: { code: "42501", message: "permission denied" } });

    const res = await POST(request(READOUT));

    expect(res.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: { where: "hosted-usage:insert", code: "42501" },
    });
  });
});
