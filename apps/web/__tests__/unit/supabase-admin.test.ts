import { beforeEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.fn().mockReturnValue({ kind: "admin-client" });
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

describe("createAdminClient", () => {
  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    vi.doMock("@/env", () => ({
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co" },
    }));
    const { createAdminClient } = await import("@/lib/supabase/admin");
    expect(() => createAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("returns a cached client across calls", async () => {
    vi.doMock("@/env", () => ({
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-key",
      },
    }));
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const first = createAdminClient();
    const second = createAdminClient();
    expect(first).toBe(second);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "service-key",
      expect.objectContaining({
        auth: expect.objectContaining({ autoRefreshToken: false, persistSession: false }),
      }),
    );
  });
});
