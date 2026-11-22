import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { emptyMetrics } from "../fixtures/product-metrics";

const SECRET = "c".repeat(40);
const mockEnv: { CRON_SECRET: string | undefined; APP_URL: string } = {
  CRON_SECRET: SECRET,
  APP_URL: "https://drafto.eu",
};
vi.mock("@/env", () => ({
  env: {
    get CRON_SECRET() {
      return mockEnv.CRON_SECRET;
    },
    get APP_URL() {
      return mockEnv.APP_URL;
    },
  },
}));

const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
}));

const adminClient = { tag: "admin" };
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...a: unknown[]) => mockCreateAdminClient(...a),
}));

const mockLoad = vi.fn();
vi.mock("@/lib/metrics/load-product-metrics", () => ({
  loadProductMetrics: (...a: unknown[]) => mockLoad(...a),
}));

const mockListAdminEmails = vi.fn();
vi.mock("@/lib/auth/list-admin-emails", () => ({
  listAdminEmails: (...a: unknown[]) => mockListAdminEmails(...a),
}));

const mockSendEmail = vi.fn();
vi.mock("@/lib/email/client", () => ({
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
}));

const { GET } = await import("@/app/api/cron/weekly-metrics/route");

function request(auth: string | null = `Bearer ${SECRET}`, userAgent?: string) {
  return new NextRequest("http://localhost:3000/api/cron/weekly-metrics", {
    headers: {
      ...(auth === null ? {} : { Authorization: auth }),
      ...(userAgent ? { "User-Agent": userAgent } : {}),
    },
  });
}

const METRICS = emptyMetrics();

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.CRON_SECRET = SECRET;
  mockCreateAdminClient.mockReturnValue(adminClient);
  mockLoad.mockResolvedValue(METRICS);
  mockListAdminEmails.mockResolvedValue({ emails: ["a@x.eu", "b@x.eu"], failed: false });
  mockSendEmail.mockResolvedValue({ id: "email-1" });
});

describe("GET /api/cron/weekly-metrics: auth", () => {
  it.each([
    ["no Authorization header", null],
    ["a wrong secret", "Bearer wrong"],
    ["the secret without Bearer", SECRET],
    ["a longer secret", `Bearer ${SECRET}x`],
  ])("rejects %s with 401", async (_label, auth) => {
    const res = await GET(request(auth));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Unauthorized" });
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("rejects every call with 401 when CRON_SECRET isn't set", async () => {
    mockEnv.CRON_SECRET = undefined;
    const res = await GET(request("Bearer "));
    expect(res.status).toBe(401);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("alerts Sentry when Vercel Cron calls without CRON_SECRET set", async () => {
    mockEnv.CRON_SECRET = undefined;
    const res = await GET(request(null, "vercel-cron/1.0"));
    expect(res.status).toBe(401);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "CRON_SECRET is not set: the Monday metrics email can't run",
      "error",
    );
  });
});

describe("GET /api/cron/weekly-metrics: sending", () => {
  it("emails each admin once and returns counts, never the metrics", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sent: 2, recipients: 2, generatedAt: METRICS.generatedAt });

    expect(mockCreateAdminClient).toHaveBeenCalledWith("web-cron");
    expect(mockLoad).toHaveBeenCalledWith({
      now: expect.any(Date),
      client: adminClient,
      emptiedNotesDays: 7,
    });
    expect(mockListAdminEmails).toHaveBeenCalledWith(adminClient);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail.mock.calls.map((c) => c[0].to)).toEqual(["a@x.eu", "b@x.eu"]);
    const [input] = mockSendEmail.mock.calls[0];
    expect(input).toMatchObject({ replyTo: "support@drafto.eu" });
    expect(input.subject).toMatch(/^Drafto weekly metrics — \d{4}-W\d{2}$/);
    expect(input.html).toContain("https://drafto.eu/admin/stats");
    expect(input.text).toContain("All metrics: https://drafto.eu/admin/stats");
  });

  it("emails one admin", async () => {
    mockListAdminEmails.mockResolvedValue({ emails: ["a@x.eu"], failed: false });
    const res = await GET(request());
    expect(await res.json()).toMatchObject({ sent: 1, recipients: 1 });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("logs and sends nothing when there are no admins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListAdminEmails.mockResolvedValue({ emails: [], failed: false });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, recipients: 0, generatedAt: METRICS.generatedAt });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[weekly-metrics] no admin accounts: nothing sent");
    warn.mockRestore();
  });

  it("returns 500 when the admins can't be listed", async () => {
    mockListAdminEmails.mockResolvedValue({ emails: [], failed: true });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns 500 when the service role isn't configured", async () => {
    mockCreateAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
    });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: { where: "weekly-metrics:client" },
    });
  });

  it("returns 502 and reports to Sentry when a send fails", async () => {
    mockSendEmail.mockResolvedValueOnce({ id: "ok" }).mockResolvedValueOnce(null);
    const res = await GET(request());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ sent: 1, recipients: 2, generatedAt: METRICS.generatedAt });
    expect(mockCaptureException).toHaveBeenCalledWith(
      new Error("weekly-metrics: 1 of 2 sends failed"),
      { extra: { where: "weekly-metrics:send", sent: 1, recipients: 2 } },
    );
  });

  it("marks the subject when something needs attention", async () => {
    mockLoad.mockResolvedValue({
      ...METRICS,
      platformLimits: { status: "error", message: "boom" },
    });
    await GET(request());
    expect(mockSendEmail.mock.calls[0][0].subject).toMatch(/ — needs attention$/);
  });
});
