import { describe, expect, it, vi } from "vitest";
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

    it("returns user and supabase client when authenticated", async () => {
      const mockSupabase = {
        auth: {
          getUser: () =>
            Promise.resolve({
              data: { user: { id: "user-1", email: "test@test.com" } },
              error: null,
            }),
        },
      };

      const { createClient } = await import("@/lib/supabase/server");
      vi.mocked(createClient).mockResolvedValue(
        mockSupabase as ReturnType<typeof createClient> extends Promise<infer T> ? T : never,
      );

      const { getAuthenticatedUser } = await import("@/lib/api/utils");
      const result = await getAuthenticatedUser();

      expect(result.error).toBeNull();
      expect(result.data!.user.id).toBe("user-1");
      expect(result.data!.user.email).toBe("test@test.com");
    });
  });
});
