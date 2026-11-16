import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
  useRouter: () => ({ push: vi.fn() }),
}));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const PENDING_ID = "22222222-2222-4222-8222-222222222222";
const APPROVED_ID = "33333333-3333-4333-8333-333333333333";

const EMAILS: Record<string, string> = {
  [ADMIN_ID]: "admin@example.com",
  [PENDING_ID]: "pending@example.com",
  [APPROVED_ID]: "approved@example.com",
};

const mockRpc = vi.fn();
const getUserByIdMock = vi.fn(async (id: string) => ({
  data: { user: EMAILS[id] ? { email: EMAILS[id] } : null },
  error: null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }),
    },
    from: () => ({
      select: (columns: string) => ({
        eq: () =>
          columns === "is_admin"
            ? { single: async () => ({ data: { is_admin: true }, error: null }) }
            : {
                order: async () => ({
                  data: [
                    {
                      id: PENDING_ID,
                      display_name: "Pending Person",
                      created_at: "2026-11-01T00:00:00Z",
                    },
                  ],
                  error: null,
                }),
              },
      }),
    }),
    rpc: mockRpc,
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById: getUserByIdMock } } }),
}));

const { default: AdminPage } = await import("@/app/(app)/admin/page");

const props = { searchParams: Promise.resolve({}) };

describe("AdminPage storage quotas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists every user's storage next to the pending approvals", async () => {
    mockRpc.mockResolvedValue({
      data: [
        { user_id: ADMIN_ID, used_bytes: 0, quota_bytes: null },
        { user_id: PENDING_ID, used_bytes: 1048576, quota_bytes: 52428800 },
        // Bigints can arrive as numeric strings.
        { user_id: APPROVED_ID, used_bytes: "5242880", quota_bytes: "52428800" },
      ],
      error: null,
    });

    render(await AdminPage(props));

    expect(mockRpc).toHaveBeenCalledWith("admin_storage_usage");
    expect(screen.getByText("1 pending")).toBeInTheDocument();

    const table = within(screen.getByTestId("admin-storage-table"));
    expect(table.getByRole("columnheader", { name: "Storage used" })).toBeInTheDocument();
    expect(table.getByRole("columnheader", { name: "Quota" })).toBeInTheDocument();

    const adminRow = within(table.getByText("admin@example.com").closest("tr")!);
    expect(adminRow.getByText("Current: Unlimited")).toBeInTheDocument();
    const approvedRow = within(table.getByText("approved@example.com").closest("tr")!);
    expect(approvedRow.getByText("5 MB")).toBeInTheDocument();
    expect(approvedRow.getByText("Current: 50 MB")).toBeInTheDocument();
    expect(table.getByText("pending@example.com")).toBeInTheDocument();

    // The pending user appears in both lists but is looked up once.
    expect(getUserByIdMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the approval list when storage usage can't be loaded", async () => {
    const failure = { message: "boom", code: "XX000" };
    mockRpc.mockResolvedValue({ data: null, error: failure });

    render(await AdminPage(props));

    expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Storage usage could not be loaded.");
    expect(screen.queryByTestId("admin-storage-table")).not.toBeInTheDocument();
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      extra: { where: "admin-page:admin_storage_usage" },
    });
  });
});
