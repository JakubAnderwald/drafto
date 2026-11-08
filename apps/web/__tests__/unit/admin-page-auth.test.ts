import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, AuthSessionMissingError } from "@supabase/supabase-js";
import { isSignedOutAuthError } from "@/lib/supabase/auth-errors";

const mockGetUser = vi.fn();
const mockRedirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

const { default: AdminPage } = await import("@/app/(app)/admin/page");

const props = { searchParams: Promise.resolve({}) };

describe("isSignedOutAuthError", () => {
  it("is true for a missing session", () => {
    expect(isSignedOutAuthError(new AuthSessionMissingError())).toBe(true);
  });

  it("is true for a token the Auth API rejected (401/403)", () => {
    expect(isSignedOutAuthError(new AuthApiError("invalid JWT", 401, "bad_jwt"))).toBe(true);
    expect(isSignedOutAuthError(new AuthApiError("no session", 403, "session_not_found"))).toBe(
      true,
    );
  });

  it("is false for Auth API server errors and non-auth errors", () => {
    expect(isSignedOutAuthError(new AuthApiError("boom", 500, "unexpected_failure"))).toBe(false);
    expect(isSignedOutAuthError(new Error("fetch failed"))).toBe(false);
    expect(isSignedOutAuthError(null)).toBe(false);
  });
});

describe("AdminPage auth handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /login when there is no auth session", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: new AuthSessionMissingError(),
    });

    await expect(AdminPage(props)).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to /login when there is no user and no error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(AdminPage(props)).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("rethrows Auth API server errors instead of redirecting", async () => {
    const serverError = new AuthApiError("boom", 500, "unexpected_failure");
    mockGetUser.mockResolvedValue({ data: { user: null }, error: serverError });

    await expect(AdminPage(props)).rejects.toBe(serverError);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("rethrows errors that are not auth errors", async () => {
    const networkError = new Error("fetch failed");
    mockGetUser.mockResolvedValue({ data: { user: null }, error: networkError });

    await expect(AdminPage(props)).rejects.toBe(networkError);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
