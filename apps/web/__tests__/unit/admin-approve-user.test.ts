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

const sendEmailMock = vi.fn().mockResolvedValue({ id: "email-1" });
vi.mock("@/lib/email/client", () => ({
  sendEmail: (input: unknown) => sendEmailMock(input),
}));

const adminGetUserByIdMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { getUserById: adminGetUserByIdMock } },
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

const { POST } = await import("@/app/api/admin/approve-user/route");

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const INACTIVE_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const ACTIVE_ID = "cccccccc-0000-4000-8000-000000000003";
const MISSING_ID = "eeeeeeee-0000-4000-8000-000000000005";
const NON_ADMIN_ID = "ffffffff-0000-4000-8000-000000000006";

interface ProfileRow {
  is_admin: boolean;
  is_approved: boolean;
  display_name: string | null;
}

type DbError = { message: string } | null;

const updateMock = vi.fn();
const updateFiltersMock = vi.fn();

/**
 * Mocks the profile lookups (`select().eq().single()` / `.maybeSingle()`) and the activate
 * update (`update().eq("id").eq("is_approved", false).select().maybeSingle()`), which matches
 * a row only when it exists and is inactive — as PostgREST would.
 */
function mockProfiles(options: { updateError?: DbError; lookupError?: DbError } = {}) {
  const rows: Record<string, ProfileRow> = {
    [ADMIN_ID]: { is_admin: true, is_approved: true, display_name: null },
    [INACTIVE_ID]: { is_admin: false, is_approved: false, display_name: "Jane" },
    [ACTIVE_ID]: { is_admin: false, is_approved: true, display_name: null },
    [NON_ADMIN_ID]: { is_admin: false, is_approved: true, display_name: null },
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
            eq: (column: string, value: boolean) => {
              updateFiltersMock(idColumn, id, column, value);
              const row = rows[id];
              const matched = row && row.is_approved === value;
              return {
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve(
                      options.updateError
                        ? { data: null, error: options.updateError }
                        : {
                            data: matched ? { id, display_name: row.display_name } : null,
                            error: null,
                          },
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
      : { data: { user: null }, error: { message: "Not authenticated" } },
  );
}

function createRequest(body: unknown, { raw = false }: { raw?: boolean } = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/admin/approve-user", {
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

describe("POST /api/admin/approve-user (activate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ id: "email-1" });
    adminGetUserByIdMock.mockResolvedValue({
      data: { user: { email: "approved@example.com" } },
      error: null,
    });
    mockProfiles();
    authenticateAs(ADMIN_ID);
  });

  it("returns 401 when not authenticated", async () => {
    authenticateAs(null);
    const response = await POST(createRequest({ userId: INACTIVE_ID }));
    expect(response.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not an admin", async () => {
    authenticateAs(NON_ADMIN_ID);
    await expectRejected({ userId: INACTIVE_ID }, 403, "Forbidden");
  });

  it("validates the body", async () => {
    await expectRejected("{not json", 400, "Invalid JSON body", true);
    await expectRejected({}, 400, "userId is required");
    await expectRejected({ userId: "user-2" }, 400, "userId must be a valid UUID");
  });

  it("activates an inactive user and sends the account-active email", async () => {
    const response = await POST(createRequest({ userId: INACTIVE_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledWith({ is_approved: true });
    expect(updateFiltersMock).toHaveBeenCalledWith("id", INACTIVE_ID, "is_approved", false);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const emailCall = sendEmailMock.mock.calls[0][0];
    expect(emailCall.to).toBe("approved@example.com");
    expect(emailCall.subject).toBe("Your Drafto account is active");
    expect(emailCall.html).toContain("Hi Jane");
  });

  it("succeeds without a second email when the account is already active", async () => {
    const response = await POST(createRequest({ userId: ACTIVE_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, alreadyActive: true });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown user", async () => {
    const response = await POST(createRequest({ userId: MISSING_ID }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "User not found" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("reports and answers 500 when the update fails", async () => {
    const failure = { message: "boom" };
    mockProfiles({ updateError: failure });
    const response = await POST(createRequest({ userId: INACTIVE_ID }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Failed to activate user" });
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      extra: { where: "approve-user:update", userId: INACTIVE_ID },
    });
  });

  it("reports and answers 500 when the follow-up lookup fails", async () => {
    const failure = { message: "lookup boom" };
    mockProfiles({ lookupError: failure });
    const response = await POST(createRequest({ userId: ACTIVE_ID }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Failed to look up user" });
  });

  it("still returns success if the email send fails", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("resend down"));
    const response = await POST(createRequest({ userId: INACTIVE_ID }));
    expect(response.status).toBe(200);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      extra: { where: "approve-user:notify", userId: INACTIVE_ID },
    });
  });
});
