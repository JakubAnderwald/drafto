import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    APPROVAL_LINK_SECRET: "test-secret-must-be-at-least-32-chars-long!",
    APP_URL: "https://drafto.eu",
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

const serverGetUserMock = vi.fn();
const serverProfilesSingleMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: serverGetUserMock },
    from: () => ({
      select: () => ({
        eq: () => ({ single: serverProfilesSingleMock }),
      }),
    }),
  }),
}));

const adminUpdateMock = vi.fn();
const adminExistingMaybeSingleMock = vi.fn();
const adminGetUserByIdMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      // Update path: .update(...).eq(id).eq(is_approved).select(...).maybeSingle()
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: () => ({ maybeSingle: adminUpdateMock }),
          }),
        }),
      }),
      // Post-update existence check: .select(...).eq(id).maybeSingle()
      select: () => ({
        eq: () => ({ maybeSingle: adminExistingMaybeSingleMock }),
      }),
    }),
    auth: { admin: { getUserById: adminGetUserByIdMock } },
  }),
}));

const { signApprovalToken } = await import("@/lib/approval-tokens");
const { GET } = await import("@/app/api/admin/approve-user/one-click/route");

function buildRequest(token: string | null): NextRequest {
  const url = new URL("http://localhost:3000/api/admin/approve-user/one-click");
  if (token) url.searchParams.set("token", token);
  return new NextRequest(url);
}

describe("GET /api/admin/approve-user/one-click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ id: "email-1" });
  });

  it("redirects to /admin?error=missing_token when no token", async () => {
    const response = await GET(buildRequest(null));
    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/admin");
    expect(location).toContain("error=missing_token");
  });

  it("redirects with invalid_or_expired_token for bad token", async () => {
    const response = await GET(buildRequest("not-a-real-token"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=invalid_or_expired_token");
  });

  it("redirects to /login when user is not authenticated", async () => {
    serverGetUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const token = signApprovalToken("target-user");

    const response = await GET(buildRequest(token));
    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain("next=");
  });

  it("redirects with forbidden error when signed in but not admin", async () => {
    serverGetUserMock.mockResolvedValue({
      data: { user: { id: "non-admin", email: "u@example.com" } },
      error: null,
    });
    serverProfilesSingleMock.mockResolvedValue({ data: { is_admin: false }, error: null });
    const token = signApprovalToken("target-user");

    const response = await GET(buildRequest(token));
    expect(response.headers.get("location")).toContain("error=forbidden");
  });

  it("approves the user, sends email, and redirects to /admin?approved=approved", async () => {
    serverGetUserMock.mockResolvedValue({
      data: { user: { id: "admin-1", email: "admin@drafto.eu" } },
      error: null,
    });
    serverProfilesSingleMock.mockResolvedValue({ data: { is_admin: true }, error: null });
    adminUpdateMock.mockResolvedValue({
      data: { id: "target-user", display_name: "Jane" },
      error: null,
    });
    adminGetUserByIdMock.mockResolvedValue({
      data: { user: { email: "jane@example.com" } },
      error: null,
    });

    const token = signApprovalToken("target-user");
    const response = await GET(buildRequest(token));
    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/admin");
    expect(location).toContain("approved=approved");
    // No email address should appear in the URL (PII via query string)
    expect(location).not.toContain("jane%40example.com");
    expect(location).not.toContain("jane@example.com");
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("redirects with approved_email_failed when approval email cannot be sent", async () => {
    serverGetUserMock.mockResolvedValue({
      data: { user: { id: "admin-1", email: "admin@drafto.eu" } },
      error: null,
    });
    serverProfilesSingleMock.mockResolvedValue({ data: { is_admin: true }, error: null });
    adminUpdateMock.mockResolvedValue({
      data: { id: "target-user", display_name: null },
      error: null,
    });
    adminGetUserByIdMock.mockResolvedValue({
      data: { user: { email: "jane@example.com" } },
      error: null,
    });
    sendEmailMock.mockResolvedValueOnce(null);

    const token = signApprovalToken("target-user");
    const response = await GET(buildRequest(token));
    expect(response.headers.get("location")).toContain("approved=approved_email_failed");
  });

  it("redirects with approved=already_approved when user already approved (no re-email)", async () => {
    serverGetUserMock.mockResolvedValue({
      data: { user: { id: "admin-1", email: "admin@drafto.eu" } },
      error: null,
    });
    serverProfilesSingleMock.mockResolvedValue({ data: { is_admin: true }, error: null });
    adminUpdateMock.mockResolvedValue({ data: null, error: null });
    adminExistingMaybeSingleMock.mockResolvedValue({
      data: { is_approved: true },
      error: null,
    });

    const token = signApprovalToken("target-user");
    const response = await GET(buildRequest(token));
    expect(response.headers.get("location")).toContain("approved=already_approved");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("redirects with user_not_found when profile no longer exists", async () => {
    serverGetUserMock.mockResolvedValue({
      data: { user: { id: "admin-1", email: "admin@drafto.eu" } },
      error: null,
    });
    serverProfilesSingleMock.mockResolvedValue({ data: { is_admin: true }, error: null });
    adminUpdateMock.mockResolvedValue({ data: null, error: null });
    adminExistingMaybeSingleMock.mockResolvedValue({ data: null, error: null });

    const token = signApprovalToken("deleted-user");
    const response = await GET(buildRequest(token));
    expect(response.headers.get("location")).toContain("error=user_not_found");
  });
});
