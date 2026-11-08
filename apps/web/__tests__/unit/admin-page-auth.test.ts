import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("AdminPage auth handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /login when there is no auth session", async () => {
    const sessionMissing = Object.assign(new Error("Auth session missing!"), {
      name: "AuthSessionMissingError",
      __isAuthError: true,
      status: 400,
    });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: sessionMissing });

    await expect(AdminPage(props)).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to /login when there is no user and no error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(AdminPage(props)).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("rethrows errors that are not auth errors", async () => {
    const networkError = new Error("fetch failed");
    mockGetUser.mockResolvedValue({ data: { user: null }, error: networkError });

    await expect(AdminPage(props)).rejects.toBe(networkError);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
