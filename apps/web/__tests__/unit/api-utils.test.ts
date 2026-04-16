import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/api/utils";

// Mock Supabase server client for getAuthenticatedUser tests
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  },
}));

describe("API utils", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("errorResponse", () => {
    it("returns a JSON error response with the given message and status", async () => {
      const response = errorResponse("Not Found", 404);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe("Not Found");
      expect(body.status).toBe(404);
    });

    it("returns 401 for unauthorized errors", async () => {
      const response = errorResponse("Unauthorized", 401);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe("Unauthorized");
    });
  });

  describe("successResponse", () => {
    it("returns a JSON success response with data", async () => {
      const data = { id: "123", name: "Test Notebook" };
      const response = successResponse(data);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(data);
    });

    it("supports custom status codes", async () => {
      const response = successResponse({ id: "123" }, 201);

      expect(response.status).toBe(201);
    });
  });

  describe("getAuthenticatedUser", () => {
    it("returns error when user is not authenticated", async () => {
      const { createClient } = await import("@/lib/supabase/server");
      vi.mocked(createClient).mockResolvedValue({
        auth: {
          getUser: () =>
            Promise.resolve({ data: { user: null }, error: { message: "Not authenticated" } }),
        },
      } as ReturnType<typeof createClient> extends Promise<infer T> ? T : never);

      const { getAuthenticatedUser } = await import("@/lib/api/utils");
      const result = await getAuthenticatedUser();

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error!.status).toBe(401);
    });

    it("returns 403 when user is not approved", async () => {
      const mockFrom = vi.fn().mockImplementation((table: string) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { is_approved: false }, error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const { createClient } = await import("@/lib/supabase/server");
      vi.mocked(createClient).mockResolvedValue({
        auth: {
          getUser: () =>
            Promise.resolve({
              data: { user: { id: "user-1", email: "test@test.com" } },
              error: null,
            }),
        },
        from: mockFrom,
      } as unknown as ReturnType<typeof createClient> extends Promise<infer T> ? T : never);

      const { getAuthenticatedUser } = await import("@/lib/api/utils");
      const result = await getAuthenticatedUser();

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error!.status).toBe(403);
    });

    it("returns user and supabase client when authenticated and approved", async () => {
      const mockFrom = vi.fn().mockImplementation((table: string) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const mockSupabase = {
        auth: {
          getUser: () =>
            Promise.resolve({
              data: { user: { id: "user-1", email: "test@test.com" } },
              error: null,
            }),
        },
        from: mockFrom,
      };

      const { createClient } = await import("@/lib/supabase/server");
      vi.mocked(createClient).mockResolvedValue(
        mockSupabase as unknown as ReturnType<typeof createClient> extends Promise<infer T>
          ? T
          : never,
      );

      const { getAuthenticatedUser } = await import("@/lib/api/utils");
      const result = await getAuthenticatedUser();

      expect(result.error).toBeNull();
      expect(result.data!.user.id).toBe("user-1");
      expect(result.data!.user.email).toBe("test@test.com");
    });
  });

  describe("getAuthenticatedUserFast", () => {
    it("uses middleware headers when present with valid UUID", async () => {
      const mockSupabase = { auth: {}, from: vi.fn() };
      const { createClient } = await import("@/lib/supabase/server");
      vi.mocked(createClient).mockResolvedValue(
        mockSupabase as unknown as ReturnType<typeof createClient> extends Promise<infer T>
          ? T
          : never,
      );

      const { getAuthenticatedUserFast } = await import("@/lib/api/utils");
      const request = new NextRequest("http://localhost:3000/api/notebooks", {
        headers: {
          "x-verified-user-id": "ca4c5472-d5a1-4a15-8223-26ff5dfd447b",
          "x-verified-user-email": "test@test.com",
        },
      });

      const result = await getAuthenticatedUserFast(request);

      expect(result.error).toBeNull();
      expect(result.data!.user.id).toBe("ca4c5472-d5a1-4a15-8223-26ff5dfd447b");
      expect(result.data!.user.email).toBe("test@test.com");
      // Should NOT call auth.getUser — fast path skips it
    });

    it("falls back to full auth when headers are absent", async () => {
      const { createClient } = await import("@/lib/supabase/server");
      vi.mocked(createClient).mockResolvedValue({
        auth: {
          getUser: () =>
            Promise.resolve({ data: { user: null }, error: { message: "Not authenticated" } }),
        },
      } as ReturnType<typeof createClient> extends Promise<infer T> ? T : never);

      const { getAuthenticatedUserFast } = await import("@/lib/api/utils");
      const request = new NextRequest("http://localhost:3000/api/notebooks");

      const result = await getAuthenticatedUserFast(request);

      expect(result.data).toBeNull();
      expect(result.error!.status).toBe(401);
    });

    it("falls back to full auth when user ID is not a valid UUID", async () => {
      const { createClient } = await import("@/lib/supabase/server");
      vi.mocked(createClient).mockResolvedValue({
        auth: {
          getUser: () =>
            Promise.resolve({ data: { user: null }, error: { message: "Not authenticated" } }),
        },
      } as ReturnType<typeof createClient> extends Promise<infer T> ? T : never);

      const { getAuthenticatedUserFast } = await import("@/lib/api/utils");
      const request = new NextRequest("http://localhost:3000/api/notebooks", {
        headers: {
          "x-verified-user-id": "not-a-valid-uuid",
          "x-verified-user-email": "hacker@evil.com",
        },
      });

      const result = await getAuthenticatedUserFast(request);

      // Should fall back to full auth (which returns 401 since no session)
      expect(result.data).toBeNull();
      expect(result.error!.status).toBe(401);
    });
  });

  describe("successResponse with headers", () => {
    it("includes custom headers when provided", async () => {
      const response = successResponse({ ok: true }, 200, {
        "Cache-Control": "private, no-cache",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    });
  });
});
