import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockEnv: { CRON_SECRET: string | undefined } = { CRON_SECRET: undefined };
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    get CRON_SECRET() {
      return mockEnv.CRON_SECRET;
    },
  },
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockUserRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockUserRpc,
  }),
}));

const mockAdminRpc = vi.fn();
const adminClient = { rpc: mockAdminRpc };
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => mockCreateAdminClient(...args),
}));

const mockRemoveOrphanedAttachments = vi.fn();
vi.mock("@/lib/storage/remove-orphaned-attachments", () => ({
  removeOrphanedAttachments: (...args: unknown[]) => mockRemoveOrphanedAttachments(...args),
}));

const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

function signedOut() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not authenticated" } });
}

function mockAdminCheck(isAdmin: boolean) {
  mockFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        single: () =>
          Promise.resolve({ data: { is_approved: true, is_admin: isAdmin }, error: null }),
      }),
    }),
  });
}

function createRequest(method: "GET" | "POST", headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/cron/cleanup-trash", { method, headers });
}

const { GET, POST } = await import("@/app/api/cron/cleanup-trash/route");

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.CRON_SECRET = undefined;
  mockCreateAdminClient.mockReturnValue(adminClient);
  mockRemoveOrphanedAttachments.mockResolvedValue(0);
});

describe("POST /api/cron/cleanup-trash", () => {
  it("returns 401 when not authenticated", async () => {
    signedOut();

    const response = await POST(createRequest("POST"));
    expect(response.status).toBe(401);
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("ignores forged x-verified-* headers and checks the session itself", async () => {
    // /api/cron is a public route, so the middleware doesn't overwrite these.
    signedOut();

    const response = await POST(
      createRequest("POST", {
        "x-verified-user-id": "11111111-1111-4111-8111-111111111111",
        "x-verified-user-email": "admin@example.com",
      }),
    );
    expect(response.status).toBe(401);
    expect(mockGetUser).toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not an admin", async () => {
    authenticateAs("user-1");
    mockAdminCheck(false);

    const response = await POST(createRequest("POST"));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("purges with the service role, then sweeps every user's orphaned files", async () => {
    authenticateAs("admin-1");
    mockAdminCheck(true);
    mockAdminRpc.mockResolvedValue({ data: 5, error: null });
    mockRemoveOrphanedAttachments.mockResolvedValue(7);

    const response = await POST(createRequest("POST"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 5, removedFiles: 7 });
    expect(mockCreateAdminClient).toHaveBeenCalledWith("web-cron");
    expect(mockAdminRpc).toHaveBeenCalledWith("cleanup_trashed_notes");
    expect(mockUserRpc).not.toHaveBeenCalled();
    // No userId: everyone's orphans.
    expect(mockRemoveOrphanedAttachments).toHaveBeenCalledWith(adminClient);
    expect(mockAdminRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoveOrphanedAttachments.mock.invocationCallOrder[0],
    );
  });

  it("returns deleted count of 0 when no notes to clean up", async () => {
    authenticateAs("admin-1");
    mockAdminCheck(true);
    mockAdminRpc.mockResolvedValue({ data: null, error: null });

    const response = await POST(createRequest("POST"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 0, removedFiles: 0 });
  });

  it("returns 500 and sweeps nothing when the purge fails", async () => {
    authenticateAs("admin-1");
    mockAdminCheck(true);
    mockAdminRpc.mockResolvedValue({ data: null, error: { message: "DB error" } });

    const response = await POST(createRequest("POST"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to cleanup trashed notes");
    expect(mockRemoveOrphanedAttachments).not.toHaveBeenCalled();
  });

  it("returns 500 and reports to Sentry when the service-role key is missing", async () => {
    authenticateAs("admin-1");
    mockAdminCheck(true);
    const missingKey = new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
    mockCreateAdminClient.mockImplementation(() => {
      throw missingKey;
    });

    const response = await POST(createRequest("POST"));
    expect(response.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalledWith(missingKey, expect.anything());
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("returns 403 when profile query fails", async () => {
    authenticateAs("admin-1");
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: { message: "DB error" } }),
        }),
      }),
    });

    const response = await POST(createRequest("POST"));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("runs with the cron secret and no session", async () => {
    mockEnv.CRON_SECRET = "cron-secret";
    signedOut();
    mockAdminRpc.mockResolvedValue({ data: 2, error: null });

    const response = await POST(createRequest("POST", { authorization: "Bearer cron-secret" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 2, removedFiles: 0 });
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/cleanup-trash (Vercel Cron)", () => {
  it("runs the purge and the sweep with the cron secret", async () => {
    mockEnv.CRON_SECRET = "cron-secret";
    mockAdminRpc.mockResolvedValue({ data: 1, error: null });
    mockRemoveOrphanedAttachments.mockResolvedValue(3);

    const response = await GET(createRequest("GET", { authorization: "Bearer cron-secret" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1, removedFiles: 3 });
  });

  it("returns 401 with a wrong secret", async () => {
    mockEnv.CRON_SECRET = "cron-secret";

    const response = await GET(createRequest("GET", { authorization: "Bearer wrong" }));
    expect(response.status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("returns 401 without an authorization header", async () => {
    mockEnv.CRON_SECRET = "cron-secret";

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(401);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("reports a missing CRON_SECRET to Sentry and runs nothing, even for a signed-in admin", async () => {
    authenticateAs("admin-1");
    mockAdminCheck(true);

    const response = await GET(createRequest("GET", { authorization: "Bearer undefined" }));
    expect(response.status).toBe(500);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("CRON_SECRET is not set"),
      "error",
    );
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });
});
