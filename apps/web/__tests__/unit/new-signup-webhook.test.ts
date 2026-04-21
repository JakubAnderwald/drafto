import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    WEBHOOK_SECRET: "correct-secret",
    APPROVAL_LINK_SECRET: "test-secret-must-be-at-least-32-chars-long!",
    APP_URL: "https://drafto.eu",
    EMAIL_ADMIN_FALLBACK: "fallback@drafto.eu",
    EMAIL_FROM: "Drafto <hello@drafto.eu>",
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const sendEmailMock = vi.fn();
vi.mock("@/lib/email/client", () => ({
  sendEmail: (input: unknown) => sendEmailMock(input),
}));

const getUserByIdMock = vi.fn();
const profilesSelectMock = vi.fn();
const adminClientFromMock = vi.fn((table: string) => {
  if (table === "profiles") {
    return {
      select: profilesSelectMock,
    };
  }
  throw new Error(`unexpected table ${table}`);
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: adminClientFromMock,
    auth: { admin: { getUserById: getUserByIdMock } },
  }),
}));

const { POST } = await import("@/app/api/webhooks/new-signup/route");

function buildRequest(body: unknown, secret: string | null = "correct-secret"): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["x-webhook-secret"] = secret;
  return new NextRequest("http://localhost:3000/api/webhooks/new-signup", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

describe("POST /api/webhooks/new-signup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ id: "email-1" });
    profilesSelectMock.mockReturnValue({
      eq: () => Promise.resolve({ data: [], error: null }),
    });
  });

  it("rejects requests with wrong secret", async () => {
    const response = await POST(buildRequest({ type: "INSERT" }, "wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("rejects requests without any secret", async () => {
    const response = await POST(buildRequest({ type: "INSERT" }, null));
    expect(response.status).toBe(401);
  });

  it("ignores non-INSERT events", async () => {
    const response = await POST(
      buildRequest({
        type: "UPDATE",
        table: "profiles",
        schema: "public",
        record: { id: "user-1" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ignored).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends email to fallback admin when no admin profile exists", async () => {
    getUserByIdMock.mockResolvedValue({
      data: { user: { email: "newuser@example.com", created_at: "2026-04-20T12:00:00Z" } },
      error: null,
    });

    const response = await POST(
      buildRequest({
        type: "INSERT",
        table: "profiles",
        schema: "public",
        record: { id: "user-1", display_name: "New User" },
      }),
    );
    expect(response.status).toBe(200);
    const okBody = await response.json();
    expect(okBody.emailSent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toEqual(["fallback@drafto.eu"]);
    expect(call.subject).toContain("newuser@example.com");
    expect(call.html).toContain("/api/admin/approve-user/one-click?token=");
  });

  it("reports emailSent: false when Resend send fails", async () => {
    getUserByIdMock.mockResolvedValue({
      data: { user: { email: "newuser@example.com", created_at: "2026-04-20T12:00:00Z" } },
      error: null,
    });
    sendEmailMock.mockResolvedValueOnce(null);

    const response = await POST(
      buildRequest({
        type: "INSERT",
        table: "profiles",
        schema: "public",
        record: { id: "user-1", display_name: null },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.emailSent).toBe(false);
  });

  it("sends email to resolved admin emails when present", async () => {
    profilesSelectMock.mockReturnValue({
      eq: () =>
        Promise.resolve({
          data: [{ id: "admin-1" }, { id: "admin-2" }],
          error: null,
        }),
    });

    const emailsById: Record<string, string> = {
      "user-1": "newuser@example.com",
      "admin-1": "admin1@drafto.eu",
      "admin-2": "admin2@drafto.eu",
    };
    getUserByIdMock.mockImplementation((id: string) =>
      Promise.resolve({
        data: { user: { email: emailsById[id], created_at: "2026-04-20T12:00:00Z" } },
        error: null,
      }),
    );

    const response = await POST(
      buildRequest({
        type: "INSERT",
        table: "profiles",
        schema: "public",
        record: { id: "user-1", display_name: null },
      }),
    );
    expect(response.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toEqual(["admin1@drafto.eu", "admin2@drafto.eu"]);
  });

  it("returns ok but skips email if auth user has no email", async () => {
    getUserByIdMock.mockResolvedValue({
      data: { user: null },
      error: { message: "not found" },
    });

    const response = await POST(
      buildRequest({
        type: "INSERT",
        table: "profiles",
        schema: "public",
        record: { id: "user-1" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
