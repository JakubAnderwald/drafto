import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

describe("handleAuthError", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // Mock window.location.href for redirect testing
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...originalLocation, href: "http://localhost:3000/app" },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: originalLocation,
    });
  });

  it("returns true and redirects to /login for 401 responses", async () => {
    const { handleAuthError } = await import("@/lib/handle-auth-error");
    const result = handleAuthError({ status: 401 } as Response);
    expect(result).toBe(true);
    expect(window.location.href).toBe("/login");
  });

  it("returns false and does not redirect for 200 responses", async () => {
    const { handleAuthError } = await import("@/lib/handle-auth-error");
    const result = handleAuthError({ status: 200 } as Response);
    expect(result).toBe(false);
    expect(window.location.href).toBe("http://localhost:3000/app");
  });

  it("returns false for 403 responses", async () => {
    const { handleAuthError } = await import("@/lib/handle-auth-error");
    const result = handleAuthError({ status: 403 } as Response);
    expect(result).toBe(false);
  });

  it("returns false for 500 responses", async () => {
    const { handleAuthError } = await import("@/lib/handle-auth-error");
    const result = handleAuthError({ status: 500 } as Response);
    expect(result).toBe(false);
  });
});
