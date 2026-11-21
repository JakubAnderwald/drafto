import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    APP_URL: "https://drafto.eu",
  },
}));

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: vi.fn(),
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

const { POST } = await import("@/app/api/admin/suspend-user/route");

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ACTIVE_ID = "cccccccc-0000-4000-8000-000000000003";
const OTHER_ADMIN_ID = "dddddddd-0000-4000-8000-000000000004";
const MISSING_ID = "eeeeeeee-0000-4000-8000-000000000005";
const NON_ADMIN_ID = "ffffffff-0000-4000-8000-000000000006";

interface ProfileRow {
  is_admin: boolean;
  is_approved: boolean;
}

type DbError = { message: string } | null;

const updateMock = vi.fn();
const updateFiltersMock = vi.fn();

/**
 * Mocks the profile lookups (`select().eq().single()` / `.maybeSingle()`) and the suspend
 * update (`update().eq("id").eq("is_admin", false).select().maybeSingle()`), which matches a
 * row only when it exists and isn't an admin — as PostgREST would.
 */
function mockProfiles(
  options: {
    rows?: Record<string, ProfileRow>;
    updateError?: DbError;
    lookupError?: DbError;
  } = {},
) {
  const rows = options.rows ?? {
    [ADMIN_ID]: { is_admin: true, is_approved: true },
    [ACTIVE_ID]: { is_admin: false, is_approved: true },
    [OTHER_ADMIN_ID]: { is_admin: true, is_approved: true },
    [NON_ADMIN_ID]: { is_admin: false, is_approved: true },
  };
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
            Promise.resolve(
              options.lookupError
                ? { data: null, error: options.lookupError }
                : { data: rows[id] ?? null, error: null },
            ),
        }),
      }),
      update: (values: Record<string, unknown>) => {
        updateMock(values);
        return {
          eq: (idColumn: string, id: string) => ({
            eq: (adminColumn: string, adminValue: boolean) => {
              updateFiltersMock(idColumn, id, adminColumn, adminValue);
              const row = rows[id];
              const matched = row && row.is_admin === adminValue;
              return {
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve(
                      options.updateError
                        ? { data: null, error: options.updateError }
                        : { data: matched ? { id } : null, error: null },
                    ),
                }),
              };
            },
          }),
        };
      },
    };
  });
}

function authenticateAs(id: string | null) {
  mockGetUser.mockResolvedValue(
    id
      ? { data: { user: { id, email: `${id}@example.com` } }, error: null }
      : { data: { user: null }, error: { message: "no session" } },
  );
}

function createRequest(body: unknown, { raw = false }: { raw?: boolean } = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/admin/suspend-user", {
    method: "POST",
    body: raw ? (body as string) : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function expectRejected(body: unknown, status: number, error: string, raw = false) {
  const response = await POST(createRequest(body, { raw }));
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error });
  expect(updateMock).not.toHaveBeenCalled();
}

describe("POST /api/admin/suspend-user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfiles();
    authenticateAs(ADMIN_ID);
  });

  it("suspends an active account through the admin's session, never touching an admin row", async () => {
    const response = await POST(createRequest({ userId: ACTIVE_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledWith({ is_approved: false });
    expect(updateFiltersMock).toHaveBeenCalledWith("id", ACTIVE_ID, "is_admin", false);
  });

  it("refuses a signed-out request", async () => {
    authenticateAs(null);
    const response = await POST(createRequest({ userId: ACTIVE_ID }));
    expect(response.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refuses a non-admin", async () => {
    authenticateAs(NON_ADMIN_ID);
    await expectRejected({ userId: ACTIVE_ID }, 403, "Forbidden");
  });

  it("reports and answers 500 when the admin check fails", async () => {
    // The middleware's verified-user header skips the auth helper's own lookup, so the route's
    // admin check is the first profile query, and it finds no row.
    mockProfiles({ rows: {} });
    const request = new NextRequest("http://localhost:3000/api/admin/suspend-user", {
      method: "POST",
      body: JSON.stringify({ userId: ACTIVE_ID }),
      headers: { "Content-Type": "application/json", "x-verified-user-id": ADMIN_ID },
    });

    const response = await POST(request);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Failed to verify admin privileges" });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      { message: "Row not found" },
      { extra: { where: "suspend-user:adminCheck", adminId: ADMIN_ID } },
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    await expectRejected("{not json", 400, "Invalid JSON body", true);
    await expectRejected({}, 400, "userId is required");
    await expectRejected({ userId: 42 }, 400, "userId is required");
    await expectRejected({ userId: "not-a-uuid" }, 400, "userId must be a valid UUID");
  });

  it("refuses to suspend the requesting admin", async () => {
    await expectRejected({ userId: ADMIN_ID }, 400, "You cannot suspend your own account");
  });

  it("refuses to suspend another admin with 409", async () => {
    const response = await POST(createRequest({ userId: OTHER_ADMIN_ID }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "Admin accounts cannot be suspended" });
    // The update ran with the is_admin = false filter and matched nothing.
    expect(updateFiltersMock).toHaveBeenCalledWith("id", OTHER_ADMIN_ID, "is_admin", false);
  });

  it("answers 404 for an unknown user", async () => {
    const response = await POST(createRequest({ userId: MISSING_ID }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "User not found" });
  });

  it("reports and answers 500 when the update fails", async () => {
    const failure = { message: "boom" };
    mockProfiles({ updateError: failure });
    const response = await POST(createRequest({ userId: ACTIVE_ID }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Failed to suspend user" });
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      extra: { where: "suspend-user:update", userId: ACTIVE_ID },
    });
  });

  it("reports and answers 500 when the follow-up lookup fails", async () => {
    const failure = { message: "lookup boom" };
    mockProfiles({ lookupError: failure });
    const response = await POST(createRequest({ userId: MISSING_ID }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Failed to look up user" });
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      extra: { where: "suspend-user:targetLookup", userId: MISSING_ID },
    });
  });
});
