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

  // A fetch that followed a redirect to /login ends on the login page's HTML with a 200.
  describe("a response redirected to /login", () => {
    it.each([
      "http://localhost:3000/login",
      "http://localhost:3000/login?next=%2Fsettings",
      "/login",
    ])("returns true and redirects to /login when the response ended at %s", async (url) => {
      const { handleAuthError } = await import("@/lib/handle-auth-error");
      const result = handleAuthError({ status: 200, redirected: true, url } as Response);
      expect(result).toBe(true);
      expect(window.location.href).toBe("/login");
    });

    it("returns false for a redirect that ended anywhere else", async () => {
      const { handleAuthError } = await import("@/lib/handle-auth-error");
      const result = handleAuthError({
        status: 200,
        redirected: true,
        url: "http://localhost:3000/waiting-for-approval",
      } as Response);
      expect(result).toBe(false);
      expect(window.location.href).toBe("http://localhost:3000/app");
    });

    it("returns false for a lookalike path", async () => {
      const { handleAuthError } = await import("@/lib/handle-auth-error");
      const result = handleAuthError({
        status: 200,
        redirected: true,
        url: "http://localhost:3000/login-help",
      } as Response);
      expect(result).toBe(false);
    });

    it("returns false for a response from /login that was not redirected", async () => {
      const { handleAuthError } = await import("@/lib/handle-auth-error");
      const result = handleAuthError({
        status: 200,
        redirected: false,
        url: "http://localhost:3000/login",
      } as Response);
      expect(result).toBe(false);
      expect(window.location.href).toBe("http://localhost:3000/app");
    });

    it("returns false instead of throwing when the final URL is malformed", async () => {
      const { handleAuthError } = await import("@/lib/handle-auth-error");
      const result = handleAuthError({
        status: 200,
        redirected: true,
        url: "http://[not-a-host/login",
      } as Response);
      expect(result).toBe(false);
      expect(window.location.href).toBe("http://localhost:3000/app");
    });
  });
});
