import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  },
}));

const adminGetUserMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { getUser: adminGetUserMock } }),
}));

const cookieGetUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: cookieGetUserMock } }),
}));

const { authenticateAccountRequest } = await import("@/lib/account/authenticate-account-request");

const TOKEN_USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const COOKIE_USER_ID = "bbbbbbbb-0000-4000-8000-000000000002";

function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/account", { method: "DELETE", headers });
}

async function expectUnauthorized(request: NextRequest): Promise<void> {
  const result = await authenticateAccountRequest(request);
  expect(result.userId).toBeNull();
  expect(result.error?.status).toBe(401);
  expect(await result.error?.json()).toEqual({ error: "Unauthorized", status: 401 });
}

describe("authenticateAccountRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminGetUserMock.mockResolvedValue({
      data: { user: { id: TOKEN_USER_ID } },
      error: null,
    });
    cookieGetUserMock.mockResolvedValue({
      data: { user: { id: COOKIE_USER_ID } },
      error: null,
    });
  });

  describe("with an Authorization header", () => {
    it("verifies the bearer token with the service-role client", async () => {
      const result = await authenticateAccountRequest(
        createRequest({ Authorization: "Bearer access-token" }),
      );

      expect(result).toEqual({ userId: TOKEN_USER_ID, error: null });
      expect(adminGetUserMock).toHaveBeenCalledWith("access-token");
      expect(cookieGetUserMock).not.toHaveBeenCalled();
    });

    it("accepts the scheme in any case", async () => {
      const result = await authenticateAccountRequest(
        createRequest({ Authorization: "bearer   access-token" }),
      );

      expect(result.userId).toBe(TOKEN_USER_ID);
      expect(adminGetUserMock).toHaveBeenCalledWith("access-token");
    });

    it("rejects a token Supabase does not accept, without falling back to the cookie", async () => {
      adminGetUserMock.mockResolvedValue({
        data: { user: null },
        error: { message: "invalid JWT", status: 401 },
      });

      await expectUnauthorized(createRequest({ Authorization: "Bearer expired-token" }));
      expect(cookieGetUserMock).not.toHaveBeenCalled();
    });

    it("rejects a verified token that resolves to no user", async () => {
      adminGetUserMock.mockResolvedValue({ data: { user: null }, error: null });

      await expectUnauthorized(createRequest({ Authorization: "Bearer orphan-token" }));
    });

    it.each([
      ["an empty bearer token", "Bearer "],
      ["a bare scheme", "Bearer"],
      ["a non-bearer scheme", "Basic dXNlcjpwYXNz"],
      ["a token with spaces", "Bearer one two"],
    ])("rejects %s without verifying or reading the cookie", async (_label, header) => {
      await expectUnauthorized(createRequest({ Authorization: header }));
      expect(adminGetUserMock).not.toHaveBeenCalled();
      expect(cookieGetUserMock).not.toHaveBeenCalled();
    });
  });

  describe("without an Authorization header", () => {
    it("verifies the session cookie", async () => {
      const result = await authenticateAccountRequest(createRequest());

      expect(result).toEqual({ userId: COOKIE_USER_ID, error: null });
      expect(cookieGetUserMock).toHaveBeenCalledWith();
      expect(adminGetUserMock).not.toHaveBeenCalled();
    });

    it("rejects a request with no session", async () => {
      cookieGetUserMock.mockResolvedValue({ data: { user: null }, error: null });

      await expectUnauthorized(createRequest());
    });

    it("rejects a session Supabase reports an error for", async () => {
      cookieGetUserMock.mockResolvedValue({
        data: { user: null },
        error: { message: "Auth session missing!" },
      });

      await expectUnauthorized(createRequest());
    });

    it("ignores forged x-verified-user headers", async () => {
      cookieGetUserMock.mockResolvedValue({ data: { user: null }, error: null });

      await expectUnauthorized(
        createRequest({
          "x-verified-user-id": "cccccccc-0000-4000-8000-000000000003",
          "x-verified-user-email": "victim@example.com",
        }),
      );
    });
  });
});
