import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    APP_URL: "https://drafto.eu",
    EMAIL_FROM: "Drafto <hello@drafto.eu>",
  },
}));

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: vi.fn(),
}));

const sendEmailMock = vi.fn();
vi.mock("@/lib/email/client", () => ({
  sendEmail: (input: unknown) => sendEmailMock(input),
}));

const deleteUserMock = vi.fn();
const storageListMock = vi.fn();
const storageRemoveMock = vi.fn();
const storageFromMock = vi.fn(() => ({ list: storageListMock, remove: storageRemoveMock }));
const ownedRowsEqMock = vi.fn();
const adminFromMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { deleteUser: deleteUserMock } },
    from: adminFromMock,
    storage: { from: storageFromMock },
  }),
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

const { POST } = await import("@/app/api/admin/delete-user/route");

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PENDING_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const APPROVED_ID = "cccccccc-0000-4000-8000-000000000003";
const PENDING_ADMIN_ID = "ffffffff-0000-4000-8000-000000000006";

interface ProfileRow {
  is_admin: boolean;
  is_approved: boolean;
}

const PROFILES: Record<string, ProfileRow> = {
  [ADMIN_ID]: { is_admin: true, is_approved: true },
  [PENDING_ID]: { is_admin: false, is_approved: false },
  [APPROVED_ID]: { is_admin: false, is_approved: true },
  [PENDING_ADMIN_ID]: { is_admin: true, is_approved: false },
};

type CountResult = { count: number | null; error: { message: string } | null };

/**
 * Mocks the service-role `from(table).select("id", { count, head }).eq("user_id", id)`
 * ownership counts. Tables not listed own nothing.
 */
function mockOwnedRows(results: Partial<Record<string, CountResult>> = {}) {
  adminFromMock.mockImplementation((table: string) => ({
    select: (_columns: string, options: { count: string; head: boolean }) => {
      expect(options).toEqual({ count: "exact", head: true });
      return {
        eq: (column: string, id: string) => {
          ownedRowsEqMock(table, column, id);
          return Promise.resolve(results[table] ?? { count: 0, error: null });
        },
      };
    },
  }));
}

type QueryResult = { data: ProfileRow | null; error: { message: string } | null };

/**
 * Mocks `supabase.from("profiles").select(...).eq("id", id)` for every lookup
 * the route (and the auth fallback) makes. `single()` errors on a missing row,
 * `maybeSingle()` returns null data — matching PostgREST.
 */
function mockProfiles(
  rows: Record<string, ProfileRow> = PROFILES,
  overrides: { maybeSingle?: QueryResult } = {},
) {
  mockFrom.mockImplementation((table: string) => {
    if (table !== "profiles") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: (_column: string, id: string) => ({
          single: () =>
            Promise.resolve(
              rows[id]
                ? { data: rows[id], error: null }
                : { data: null, error: { message: "Row not found" } },
            ),
          maybeSingle: () =>
            Promise.resolve(overrides.maybeSingle ?? { data: rows[id] ?? null, error: null }),
        }),
      }),
    };
  });
}

function authenticateAs(id: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id, email: `${id}@example.com` } },
    error: null,
  });
}

function createRequest(body: unknown, { raw = false }: { raw?: boolean } = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/admin/delete-user", {
    method: "POST",
    body: raw ? (body as string) : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function expectRejectedWithoutDeleting(
  request: NextRequest,
  status: number,
  error?: string,
): Promise<void> {
  const response = await POST(request);
  expect(response.status).toBe(status);
  if (error) {
    const body = await response.json();
    expect(body.error).toBe(error);
  }
  expect(deleteUserMock).not.toHaveBeenCalled();
  expect(storageFromMock).not.toHaveBeenCalled();
}

describe("POST /api/admin/delete-user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAs(ADMIN_ID);
    mockProfiles();
    mockOwnedRows();
    deleteUserMock.mockResolvedValue({ data: { user: null }, error: null });
    storageListMock.mockResolvedValue({ data: [], error: null });
    storageRemoveMock.mockResolvedValue({ data: [], error: null });
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not authenticated" },
    });

    await expectRejectedWithoutDeleting(createRequest({ userId: PENDING_ID }), 401);
  });

  it("returns 403 when the caller is not an admin", async () => {
    authenticateAs(APPROVED_ID);

    await expectRejectedWithoutDeleting(createRequest({ userId: PENDING_ID }), 403, "Forbidden");
  });

  it("returns 500 when the admin check itself fails", async () => {
    const request = new NextRequest("http://localhost:3000/api/admin/delete-user", {
      method: "POST",
      body: JSON.stringify({ userId: PENDING_ID }),
      headers: {
        "Content-Type": "application/json",
        // Fast-path auth skips the approval query, so the admin lookup is the first one.
        "x-verified-user-id": "dddddddd-0000-4000-8000-000000000004",
      },
    });

    await expectRejectedWithoutDeleting(request, 500, "Failed to verify admin privileges");
    expect(captureExceptionMock).toHaveBeenCalledWith(
      { message: "Row not found" },
      {
        extra: {
          where: "delete-user:adminCheck",
          adminId: "dddddddd-0000-4000-8000-000000000004",
        },
      },
    );
  });

  it("returns 400 when the body is not valid JSON", async () => {
    await expectRejectedWithoutDeleting(
      createRequest("{not json", { raw: true }),
      400,
      "Invalid JSON body",
    );
  });

  it("returns 400 when userId is missing", async () => {
    await expectRejectedWithoutDeleting(createRequest({}), 400, "userId is required");
  });

  it("returns 400 when the body is JSON null", async () => {
    await expectRejectedWithoutDeleting(createRequest(null), 400, "userId is required");
  });

  it("returns 400 when userId is not a string", async () => {
    await expectRejectedWithoutDeleting(createRequest({ userId: 42 }), 400, "userId is required");
  });

  it("returns 400 when userId is not a UUID", async () => {
    await expectRejectedWithoutDeleting(
      createRequest({ userId: "user-2" }),
      400,
      "userId must be a valid UUID",
    );
  });

  it("returns 400 when the admin tries to delete themselves", async () => {
    await expectRejectedWithoutDeleting(
      createRequest({ userId: ADMIN_ID }),
      400,
      "You cannot delete your own account",
    );
  });

  it("returns 404 when no profile exists for userId", async () => {
    await expectRejectedWithoutDeleting(
      createRequest({ userId: "eeeeeeee-0000-4000-8000-000000000005" }),
      404,
      "User not found",
    );
  });

  it("returns 500 and reports to Sentry when the target profile lookup fails", async () => {
    const lookupError = { message: "boom" };
    mockProfiles(PROFILES, { maybeSingle: { data: null, error: lookupError } });

    await expectRejectedWithoutDeleting(
      createRequest({ userId: PENDING_ID }),
      500,
      "Failed to look up user",
    );
    expect(captureExceptionMock).toHaveBeenCalledWith(lookupError, {
      extra: { where: "delete-user:targetLookup", userId: PENDING_ID },
    });
  });

  it("returns 409 and deletes nothing when the target is already approved", async () => {
    await expectRejectedWithoutDeleting(
      createRequest({ userId: APPROVED_ID }),
      409,
      "Only pending users can be deleted",
    );
  });

  it("returns 409 and deletes nothing when the target is an admin", async () => {
    await expectRejectedWithoutDeleting(
      createRequest({ userId: PENDING_ADMIN_ID }),
      409,
      "Only pending users can be deleted",
    );
  });

  it.each(["notebooks", "notes", "api_keys"])(
    "returns 409 and deletes nothing when the target already owns %s",
    async (table) => {
      mockOwnedRows({ [table]: { count: 2, error: null } });

      await expectRejectedWithoutDeleting(
        createRequest({ userId: PENDING_ID }),
        409,
        "Only pending users can be deleted: this account already has data",
      );
    },
  );

  it("returns 500, deletes nothing and reports to Sentry when an ownership lookup errors", async () => {
    const countError = { message: "boom" };
    mockOwnedRows({ notes: { count: null, error: countError } });

    await expectRejectedWithoutDeleting(
      createRequest({ userId: PENDING_ID }),
      500,
      "Failed to look up user",
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(countError, {
      extra: { where: "delete-user:ownedRows", table: "notes", userId: PENDING_ID },
    });
  });

  it("returns 500, deletes nothing and reports to Sentry when an ownership lookup returns no count", async () => {
    mockOwnedRows({ api_keys: { count: null, error: null } });

    await expectRejectedWithoutDeleting(
      createRequest({ userId: PENDING_ID }),
      500,
      "Failed to look up user",
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      new Error("Ownership count for api_keys came back empty"),
      { extra: { where: "delete-user:ownedRows", table: "api_keys", userId: PENDING_ID } },
    );
  });

  it("deletes a pending user and cleans up their attachments", async () => {
    storageListMock.mockImplementation((prefix: string) =>
      Promise.resolve(
        prefix === PENDING_ID
          ? { data: [{ name: "note-1", id: null }], error: null }
          : { data: [{ name: "photo.png", id: "obj-1" }], error: null },
      ),
    );

    const response = await POST(createRequest({ userId: PENDING_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(deleteUserMock).toHaveBeenCalledWith(PENDING_ID);
    for (const table of ["notebooks", "notes", "api_keys"]) {
      expect(ownedRowsEqMock).toHaveBeenCalledWith(table, "user_id", PENDING_ID);
    }
    expect(storageFromMock).toHaveBeenCalledWith("attachments");
    expect(storageRemoveMock).toHaveBeenCalledWith([`${PENDING_ID}/note-1/photo.png`]);
    // Storage is swept before the auth user is deleted, so a failed sweep leaves it intact.
    expect(storageRemoveMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteUserMock.mock.invocationCallOrder[0],
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("never sends an email to the deleted user", async () => {
    await POST(createRequest({ userId: PENDING_ID }));

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns 500 without deleting the user when the storage sweep fails", async () => {
    const storageError = new Error("storage unavailable");
    storageListMock.mockResolvedValue({ data: null, error: storageError });

    const response = await POST(createRequest({ userId: PENDING_ID }));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe(
      "Failed to delete the user's attachments. The user was not deleted — please try again.",
    );
    expect(deleteUserMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(storageError, {
      extra: { where: "delete-user-account:storage", userId: PENDING_ID },
    });
  });

  it("returns 500 and reports to Sentry when deleteUser returns an error", async () => {
    const deleteError = new Error("Database error deleting user");
    deleteUserMock.mockResolvedValue({ data: null, error: deleteError });

    const response = await POST(createRequest({ userId: PENDING_ID }));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Failed to delete user");
    expect(captureExceptionMock).toHaveBeenCalledWith(deleteError, {
      extra: { where: "delete-user-account:deleteUser", userId: PENDING_ID },
    });
    // Only the strict sweep before deleteUser listed storage; no sweep ran afterwards.
    expect(storageListMock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and reports to Sentry when deleteUser throws", async () => {
    const thrown = new Error("network down");
    deleteUserMock.mockRejectedValue(thrown);

    const response = await POST(createRequest({ userId: PENDING_ID }));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Failed to delete user");
    expect(captureExceptionMock).toHaveBeenCalledWith(thrown, {
      extra: { where: "delete-user-account:deleteUser", userId: PENDING_ID },
    });
    expect(storageListMock).toHaveBeenCalledTimes(1);
  });
});
