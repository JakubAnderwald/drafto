import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    APP_URL: "https://drafto.eu",
  },
}));

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: vi.fn(),
}));

const adminGetUserMock = vi.fn();
const deleteUserMock = vi.fn();
const storageListMock = vi.fn();
const storageRemoveMock = vi.fn();
const storageFromMock = vi.fn(() => ({ list: storageListMock, remove: storageRemoveMock }));
const adminFromMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { getUser: adminGetUserMock, admin: { deleteUser: deleteUserMock } },
    from: adminFromMock,
    storage: { from: storageFromMock },
  }),
}));

const cookieGetUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: cookieGetUserMock } }),
}));

const { DELETE } = await import("@/app/api/account/route");

const USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000002";

type Failure = { message: string } | null;
type ProfileLookup = { data: { is_admin: boolean } | null; error: Failure };
type AdminCount = { count: number | null; error: Failure };

const profileEqMock = vi.fn();
const adminCountEqMock = vi.fn();

/**
 * Mocks the two service-role profile queries the last-admin guard makes:
 * `select("is_admin").eq("id", id).maybeSingle()` for the caller, and
 * `select("id", { count: "exact", head: true }).eq("is_admin", true)`.
 */
function mockProfiles({
  profile = { data: { is_admin: false }, error: null },
  adminCount = { count: 1, error: null },
}: { profile?: ProfileLookup; adminCount?: AdminCount } = {}) {
  adminFromMock.mockImplementation((table: string) => {
    if (table !== "profiles") throw new Error(`unexpected table ${table}`);
    return {
      select: (columns: string, options?: { count: string; head: boolean }) => ({
        eq: (column: string, value: unknown) => {
          if (options) {
            expect(options).toEqual({ count: "exact", head: true });
            adminCountEqMock(columns, column, value);
            return Promise.resolve(adminCount);
          }
          profileEqMock(columns, column, value);
          return { maybeSingle: () => Promise.resolve(profile) };
        },
      }),
    };
  });
}

function signedInWithCookie(id: string | null) {
  cookieGetUserMock.mockResolvedValue(
    id
      ? { data: { user: { id, email: `${id}@example.com` } }, error: null }
      : { data: { user: null }, error: { message: "Auth session missing!" } },
  );
}

function createRequest({
  headers = {},
  body,
  query = "",
}: { headers?: Record<string, string>; body?: unknown; query?: string } = {}): NextRequest {
  return new NextRequest(`http://localhost:3000/api/account${query}`, {
    method: "DELETE",
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function expectStatus(response: Response, status: number, error?: string): Promise<void> {
  expect(response.status).toBe(status);
  if (error) expect((await response.json()).error).toBe(error);
}

function expectNothingDeleted() {
  expect(deleteUserMock).not.toHaveBeenCalled();
  expect(storageFromMock).not.toHaveBeenCalled();
}

async function expectUnauthorized(request: NextRequest): Promise<void> {
  await expectStatus(await DELETE(request), 401, "Unauthorized");
  expectNothingDeleted();
  expect(adminFromMock).not.toHaveBeenCalled();
}

describe("DELETE /api/account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedInWithCookie(USER_ID);
    adminGetUserMock.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    mockProfiles();
    deleteUserMock.mockResolvedValue({ data: { user: null }, error: null });
    storageListMock.mockResolvedValue({ data: [], error: null });
    storageRemoveMock.mockResolvedValue({ data: [], error: null });
  });

  describe("authentication", () => {
    it("returns 401 with no session and no bearer token", async () => {
      signedInWithCookie(null);

      await expectUnauthorized(createRequest());
      expect(adminGetUserMock).not.toHaveBeenCalled();
    });

    it("returns 401 for an invalid bearer token without falling back to the cookie", async () => {
      adminGetUserMock.mockResolvedValue({
        data: { user: null },
        error: { message: "invalid JWT", status: 401 },
      });

      await expectUnauthorized(createRequest({ headers: { Authorization: "Bearer bad-token" } }));
      expect(adminGetUserMock).toHaveBeenCalledWith("bad-token");
      expect(cookieGetUserMock).not.toHaveBeenCalled();
    });

    it("returns 401 for an empty bearer token", async () => {
      await expectUnauthorized(createRequest({ headers: { Authorization: "Bearer " } }));
      expect(adminGetUserMock).not.toHaveBeenCalled();
      expect(cookieGetUserMock).not.toHaveBeenCalled();
    });

    it("returns 401 for a forged x-verified-user-id header with no session", async () => {
      signedInWithCookie(null);

      await expectUnauthorized(
        createRequest({
          headers: {
            "x-verified-user-id": OTHER_ID,
            "x-verified-user-email": "victim@example.com",
          },
        }),
      );
    });

    it("deletes the account of a caller authenticated with a bearer token", async () => {
      signedInWithCookie(null);

      const response = await DELETE(
        createRequest({ headers: { Authorization: "Bearer good-token" } }),
      );

      await expectStatus(response, 200);
      expect(adminGetUserMock).toHaveBeenCalledWith("good-token");
      expect(cookieGetUserMock).not.toHaveBeenCalled();
      expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
    });

    it("deletes the account of a caller authenticated with a session cookie", async () => {
      const response = await DELETE(createRequest());

      await expectStatus(response, 200);
      expect(cookieGetUserMock).toHaveBeenCalled();
      expect(adminGetUserMock).not.toHaveBeenCalled();
      expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
    });

    it("deletes the verified caller, never a user id from the body, query or headers", async () => {
      const response = await DELETE(
        createRequest({
          body: { userId: OTHER_ID },
          query: `?userId=${OTHER_ID}`,
          headers: { "x-verified-user-id": OTHER_ID },
        }),
      );

      await expectStatus(response, 200);
      expect(deleteUserMock).toHaveBeenCalledTimes(1);
      expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
      expect(profileEqMock).toHaveBeenCalledWith("is_admin", "id", USER_ID);
      expect(storageListMock).not.toHaveBeenCalledWith(OTHER_ID, expect.anything());
      expect(storageListMock).toHaveBeenCalledWith(USER_ID, expect.anything());
    });
  });

  describe("last-admin guard", () => {
    it("returns 409 and deletes nothing when the caller is the only admin", async () => {
      mockProfiles({ profile: { data: { is_admin: true }, error: null } });

      await expectStatus(
        await DELETE(createRequest()),
        409,
        "You are the only admin. Make another user an admin before deleting your account.",
      );
      expectNothingDeleted();
      expect(adminCountEqMock).toHaveBeenCalledWith("id", "is_admin", true);
    });

    it("returns 409 when the admin count comes back as zero", async () => {
      mockProfiles({
        profile: { data: { is_admin: true }, error: null },
        adminCount: { count: 0, error: null },
      });

      await expectStatus(await DELETE(createRequest()), 409);
      expectNothingDeleted();
    });

    it("lets an admin delete their account when other admins remain", async () => {
      mockProfiles({
        profile: { data: { is_admin: true }, error: null },
        adminCount: { count: 2, error: null },
      });

      await expectStatus(await DELETE(createRequest()), 200);
      expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
    });

    it("does not count admins for a non-admin caller", async () => {
      await expectStatus(await DELETE(createRequest()), 200);
      expect(adminCountEqMock).not.toHaveBeenCalled();
    });

    it("treats a caller with no profile row as a non-admin", async () => {
      mockProfiles({ profile: { data: null, error: null } });

      await expectStatus(await DELETE(createRequest()), 200);
      expect(adminCountEqMock).not.toHaveBeenCalled();
      expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
    });

    it("returns 500, deletes nothing and reports to Sentry when the profile lookup fails", async () => {
      const lookupError = { message: "boom" };
      mockProfiles({ profile: { data: null, error: lookupError } });

      await expectStatus(
        await DELETE(createRequest()),
        500,
        "Failed to delete your account. Please try again.",
      );
      expectNothingDeleted();
      expect(captureExceptionMock).toHaveBeenCalledWith(lookupError, {
        extra: { where: "account-delete:profileLookup", userId: USER_ID },
      });
    });

    it("returns 500, deletes nothing and reports to Sentry when the admin count errors", async () => {
      const countError = { message: "count failed" };
      mockProfiles({
        profile: { data: { is_admin: true }, error: null },
        adminCount: { count: null, error: countError },
      });

      await expectStatus(await DELETE(createRequest()), 500);
      expectNothingDeleted();
      expect(captureExceptionMock).toHaveBeenCalledWith(countError, {
        extra: { where: "account-delete:adminCount", userId: USER_ID },
      });
    });

    it("returns 500, deletes nothing and reports to Sentry when the admin count is empty", async () => {
      mockProfiles({
        profile: { data: { is_admin: true }, error: null },
        adminCount: { count: null, error: null },
      });

      await expectStatus(await DELETE(createRequest()), 500);
      expectNothingDeleted();
      expect(captureExceptionMock).toHaveBeenCalledWith(new Error("Admin count came back empty"), {
        extra: { where: "account-delete:adminCount", userId: USER_ID },
      });
    });
  });

  describe("deletion", () => {
    it("removes the caller's attachments before deleting the auth user and returns success", async () => {
      storageListMock.mockImplementation((prefix: string) =>
        Promise.resolve(
          prefix === USER_ID
            ? { data: [{ name: "note-1", id: null }], error: null }
            : { data: [{ name: "photo.png", id: "obj-1" }], error: null },
        ),
      );

      const response = await DELETE(createRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(storageFromMock).toHaveBeenCalledWith("attachments");
      expect(storageRemoveMock).toHaveBeenCalledWith([`${USER_ID}/note-1/photo.png`]);
      expect(storageRemoveMock.mock.invocationCallOrder[0]).toBeLessThan(
        deleteUserMock.mock.invocationCallOrder[0],
      );
      expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it("returns 500 and keeps the auth user when the storage sweep fails", async () => {
      const storageError = new Error("storage unavailable");
      storageListMock.mockResolvedValue({ data: null, error: storageError });

      await expectStatus(
        await DELETE(createRequest()),
        500,
        "Failed to delete your attachments. Your account was not deleted — please try again.",
      );
      expect(deleteUserMock).not.toHaveBeenCalled();
      expect(captureExceptionMock).toHaveBeenCalledWith(storageError, {
        extra: { where: "delete-user-account:storage", userId: USER_ID },
      });
    });

    it("returns 500 and reports to Sentry when deleteUser returns an error", async () => {
      const deleteError = new Error("Database error deleting user");
      deleteUserMock.mockResolvedValue({ data: null, error: deleteError });

      await expectStatus(
        await DELETE(createRequest()),
        500,
        "Failed to delete your account. Please try again.",
      );
      expect(captureExceptionMock).toHaveBeenCalledWith(deleteError, {
        extra: { where: "delete-user-account:deleteUser", userId: USER_ID },
      });
    });

    it("returns 500 and reports to Sentry when deleteUser throws", async () => {
      const thrown = new Error("network down");
      deleteUserMock.mockRejectedValue(thrown);

      await expectStatus(
        await DELETE(createRequest({ headers: { Authorization: "Bearer good-token" } })),
        500,
        "Failed to delete your account. Please try again.",
      );
      expect(captureExceptionMock).toHaveBeenCalledWith(thrown, {
        extra: { where: "delete-user-account:deleteUser", userId: USER_ID },
      });
    });
  });
});
