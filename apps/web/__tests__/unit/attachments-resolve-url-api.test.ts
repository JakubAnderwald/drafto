import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockStorageFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    storage: { from: mockStorageFrom },
  }),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

const approvedProfile = {
  select: () => ({
    eq: () => ({
      single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
    }),
  }),
};

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
  mockFrom.mockImplementation((table: string) => {
    if (table === "profiles") return approvedProfile;
    return {};
  });
}

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/attachments/resolve-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/attachments/resolve-url", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not auth" },
    });

    const { POST } = await import("@/app/api/attachments/resolve-url/route");
    const request = createRequest({ filePath: "user-1/note-1/test.png" });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 400 when filePath is missing", async () => {
    authenticateAs("user-1");

    const { POST } = await import("@/app/api/attachments/resolve-url/route");
    const request = createRequest({});
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("filePath is required");
  });

  it("returns 400 when filePath is empty string", async () => {
    authenticateAs("user-1");

    const { POST } = await import("@/app/api/attachments/resolve-url/route");
    const request = createRequest({ filePath: "" });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("filePath is required");
  });

  it("returns 400 when body is invalid JSON", async () => {
    authenticateAs("user-1");

    const { POST } = await import("@/app/api/attachments/resolve-url/route");
    const request = new NextRequest("http://localhost:3000/api/attachments/resolve-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 403 when filePath does not belong to the user", async () => {
    authenticateAs("user-1");

    const { POST } = await import("@/app/api/attachments/resolve-url/route");
    const request = createRequest({ filePath: "other-user/note-1/test.png" });
    const response = await POST(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns signed URL for valid file path", async () => {
    authenticateAs("user-1");
    mockStorageFrom.mockReturnValue({
      createSignedUrl: () =>
        Promise.resolve({
          data: {
            signedUrl:
              "https://test.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/test.png?token=abc123",
          },
          error: null,
        }),
    });

    const { POST } = await import("@/app/api/attachments/resolve-url/route");
    const request = createRequest({ filePath: "user-1/note-1/test.png" });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signedUrl).toContain("token=abc123");
  });

  it("returns 500 when signed URL generation fails", async () => {
    authenticateAs("user-1");
    mockStorageFrom.mockReturnValue({
      createSignedUrl: () =>
        Promise.resolve({
          data: null,
          error: { message: "Signing error" },
        }),
    });

    const { POST } = await import("@/app/api/attachments/resolve-url/route");
    const request = createRequest({ filePath: "user-1/note-1/test.png" });
    const response = await POST(request);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to generate signed URL");
  });
});
