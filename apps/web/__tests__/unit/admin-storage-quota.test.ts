import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { megabytesToBytes } from "@drafto/shared";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

// The route must never fall back to the service role: the guard trigger and the
// admin RLS policy only apply to the admin's own session.
const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

const { POST } = await import("@/app/api/admin/storage-quota/route");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/admin/storage-quota", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

interface ProfilesMockOptions {
  isAdmin?: boolean;
  adminLookupError?: { message: string } | null;
  updateResult?: { data: unknown; error: unknown };
}

/** Wires `from("profiles")` for the approval check, the admin check and the update. */
function mockProfiles({
  isAdmin = true,
  adminLookupError = null,
  updateResult = { data: null, error: null },
}: ProfilesMockOptions = {}) {
  const maybeSingle = vi.fn().mockResolvedValue(updateResult);
  const select = vi.fn().mockReturnValue({ maybeSingle });
  const eq = vi.fn().mockReturnValue({ select });
  const update = vi.fn().mockReturnValue({ eq });

  let lookups = 0;
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        single: () => {
          lookups += 1;
          // First lookup: getAuthenticatedUser's approval check. Second: the admin check.
          if (lookups === 1) {
            return Promise.resolve({ data: { is_approved: true }, error: null });
          }
          return Promise.resolve(
            adminLookupError
              ? { data: null, error: adminLookupError }
              : { data: { is_admin: isAdmin }, error: null },
          );
        },
      }),
    }),
    update,
  }));

  return { update, eq, select, maybeSingle };
}

function signInAs(id: string) {
  mockGetUser.mockResolvedValue({ data: { user: { id, email: "a@example.com" } }, error: null });
}

describe("POST /api/admin/storage-quota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInAs(ADMIN_ID);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "No session" } });

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb: 10 }));
    expect(response.status).toBe(401);
  });

  it("returns 403 for a signed-in user who isn't an admin", async () => {
    const { update } = mockProfiles({ isAdmin: false });

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb: 10 }));
    expect(response.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 500 when the admin lookup fails", async () => {
    const { update } = mockProfiles({ adminLookupError: { message: "db down" } });

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb: 10 }));
    expect(response.status).toBe(500);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that isn't JSON", async () => {
    mockProfiles();

    const response = await POST(createRequest("{not json"));
    expect(response.status).toBe(400);
  });

  it.each([
    ["missing", { quotaMb: 10 }],
    ["not a uuid", { userId: "user-2", quotaMb: 10 }],
    ["not a string", { userId: 42, quotaMb: 10 }],
  ])("returns 400 when userId is %s", async (_label, body) => {
    const { update } = mockProfiles();

    const response = await POST(createRequest(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/userId/);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a fraction", 1.5],
    ["a string", "10"],
    ["above the cap", 1_000_001],
    ["an object", { mb: 10 }],
    ["a boolean", true],
  ])("returns 400 when quotaMb is %s", async (_label, quotaMb) => {
    const { update } = mockProfiles();

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/quotaMb/);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 400 when quotaMb is missing (unlimited must be an explicit null)", async () => {
    const { update } = mockProfiles();

    const response = await POST(createRequest({ userId: TARGET_ID }));
    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("sets an unlimited quota for null", async () => {
    const { update, eq, select } = mockProfiles({
      updateResult: { data: { id: TARGET_ID, storage_quota_bytes: null }, error: null },
    });

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb: null }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: TARGET_ID, quotaBytes: null });
    expect(update).toHaveBeenCalledWith({ storage_quota_bytes: null });
    expect(eq).toHaveBeenCalledWith("id", TARGET_ID);
    expect(select).toHaveBeenCalledWith("id, storage_quota_bytes");
  });

  it("converts MB to bytes", async () => {
    const bytes = megabytesToBytes(200);
    const { update } = mockProfiles({
      updateResult: { data: { id: TARGET_ID, storage_quota_bytes: bytes }, error: null },
    });

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb: 200 }));
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ storage_quota_bytes: 200 * 1024 * 1024 });
    expect(await response.json()).toEqual({ userId: TARGET_ID, quotaBytes: bytes });
  });

  it("accepts the cap itself", async () => {
    const { update } = mockProfiles({
      updateResult: {
        data: { id: TARGET_ID, storage_quota_bytes: megabytesToBytes(1_000_000) },
        error: null,
      },
    });

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb: 1_000_000 }));
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ storage_quota_bytes: megabytesToBytes(1_000_000) });
  });

  it("updates through the admin's own session, never the service role", async () => {
    mockProfiles({
      updateResult: { data: { id: TARGET_ID, storage_quota_bytes: null }, error: null },
    });

    await POST(createRequest({ userId: TARGET_ID, quotaMb: null }));
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("returns 404 when no profile has that id", async () => {
    mockProfiles({ updateResult: { data: null, error: null } });

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb: 10 }));
    expect(response.status).toBe(404);
  });

  it("returns 500 when the update fails", async () => {
    mockProfiles({
      updateResult: { data: null, error: { message: "permission denied", code: "42501" } },
    });

    const response = await POST(createRequest({ userId: TARGET_ID, quotaMb: 10 }));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Failed to update storage quota");
  });
});
