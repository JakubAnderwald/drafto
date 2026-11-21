import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, AuthSessionMissingError } from "@supabase/supabase-js";
import { emptyMetrics } from "../fixtures/product-metrics";

const mockGetUser = vi.fn();
const mockSingle = vi.fn();
const mockRedirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
const mockLoad = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: () => ({ select: () => ({ eq: () => ({ single: mockSingle }) }) }),
  })),
}));

vi.mock("@/lib/metrics/load-product-metrics", () => ({
  EMPTIED_NOTES_DAYS: 14,
  loadProductMetrics: () => mockLoad(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

const pageModule = await import("@/app/(app)/admin/stats/page");
const AdminStatsPage = pageModule.default;

const USER = { id: "11111111-1111-4111-8111-111111111111" };

describe("/admin/stats guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(emptyMetrics());
  });

  it("is recomputed on every load", () => {
    expect(pageModule.dynamic).toBe("force-dynamic");
  });

  it("sends a signed-out visitor to /login without loading metrics", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });

    await expect(AdminStatsPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("sends a non-admin to / without loading metrics", async () => {
    mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
    mockSingle.mockResolvedValue({ data: { is_admin: false }, error: null });

    await expect(AdminStatsPage()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("rethrows an Auth API server error", async () => {
    const serverError = new AuthApiError("boom", 500, "unexpected_failure");
    mockGetUser.mockResolvedValue({ data: { user: null }, error: serverError });

    await expect(AdminStatsPage()).rejects.toBe(serverError);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("rethrows a profile lookup error", async () => {
    const profileError = new Error("profiles down");
    mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
    mockSingle.mockResolvedValue({ data: null, error: profileError });

    await expect(AdminStatsPage()).rejects.toBe(profileError);
  });

  it("renders the page for an admin, with the metrics loaded", async () => {
    mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
    mockSingle.mockResolvedValue({ data: { is_admin: true }, error: null });

    const element = await AdminStatsPage();
    expect(element).toBeTruthy();
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
