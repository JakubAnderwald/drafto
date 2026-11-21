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
const listUsersMock = vi.fn(async () => ({
  data: { users: Object.entries(EMAILS).map(([id, email]) => ({ id, email })) },
  error: null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }),
    },
    from: () => ({
      select: (columns: string) =>
        columns === "is_admin"
          ? { eq: () => ({ single: async () => ({ data: { is_admin: true }, error: null }) }) }
          : {
              // Every account, newest first (ADR 0094).
              order: async () => ({
                data: [
                  {
                    id: PENDING_ID,
                    display_name: "Pending Person",
                    created_at: "2026-11-01T00:00:00Z",
                    is_approved: false,
                    is_admin: false,
                  },
                  {
                    id: APPROVED_ID,
                    display_name: null,
                    created_at: "2026-10-01T00:00:00Z",
                    is_approved: true,
                    is_admin: false,
                  },
                  {
                    id: ADMIN_ID,
                    display_name: null,
                    created_at: "2026-09-01T00:00:00Z",
                    is_approved: true,
                    is_admin: true,
                  },
                ],
                error: null,
              }),
            },
    }),
    rpc: mockRpc,
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { listUsers: listUsersMock } } }),
}));

const { default: AdminPage } = await import("@/app/(app)/admin/page");

const STORAGE_ROWS = [
  { user_id: ADMIN_ID, used_bytes: 0, quota_bytes: null },
  { user_id: PENDING_ID, used_bytes: 1048576, quota_bytes: 52428800 },
  // Bigints can arrive as numeric strings.
  { user_id: APPROVED_ID, used_bytes: "5242880", quota_bytes: "52428800" },
];

const CONTENT_ROWS = [
  { user_id: ADMIN_ID, used_bytes: 0, quota_bytes: null },
  { user_id: PENDING_ID, used_bytes: 0, quota_bytes: 26214400 },
  { user_id: APPROVED_ID, used_bytes: "3145728", quota_bytes: "26214400" },
];

type RpcResult = { data: unknown; error: unknown };

/** Answers each admin RPC by name. */
function mockRpcs(results: { storage: RpcResult; content: RpcResult }) {
  mockRpc.mockImplementation(async (name: string) =>
    name === "admin_storage_usage" ? results.storage : results.content,
  );
}

describe("AdminPage storage quotas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists every user's storage and notes usage next to the account list", async () => {
    mockRpcs({
      storage: { data: STORAGE_ROWS, error: null },
      content: { data: CONTENT_ROWS, error: null },
    });

    render(await AdminPage());

    expect(mockRpc).toHaveBeenCalledWith("admin_storage_usage");
    expect(mockRpc).toHaveBeenCalledWith("admin_content_usage");
    expect(screen.getByText(/^1 inactive/)).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();

    const table = within(screen.getByTestId("admin-storage-table"));
    expect(table.getByRole("columnheader", { name: "Storage used" })).toBeInTheDocument();
    expect(table.getByRole("columnheader", { name: "Quota" })).toBeInTheDocument();
    expect(table.getByRole("columnheader", { name: "Notes used" })).toBeInTheDocument();
    expect(table.getByRole("columnheader", { name: "Notes quota" })).toBeInTheDocument();

    const adminRow = within(table.getByText("admin@example.com").closest("tr")!);
    expect(adminRow.getAllByText("Current: Unlimited")).toHaveLength(2);
    const approvedRow = within(table.getByText("approved@example.com").closest("tr")!);
    expect(approvedRow.getByText("5 MB")).toBeInTheDocument();
    expect(approvedRow.getByText("Current: 50 MB")).toBeInTheDocument();
    expect(approvedRow.getByText("3 MB")).toBeInTheDocument();
    expect(approvedRow.getByText("Current: 25 MB")).toBeInTheDocument();
    expect(table.getByText("pending@example.com")).toBeInTheDocument();

    // Both lists share one paged listing of the auth users.
    expect(listUsersMock).toHaveBeenCalledTimes(1);
    expect(listUsersMock).toHaveBeenCalledWith({ page: 1, perPage: 1000 });
  });

  it("keeps the account list when storage usage can't be loaded", async () => {
    const failure = { message: "boom", code: "XX000" };
    mockRpcs({
      storage: { data: null, error: failure },
      content: { data: CONTENT_ROWS, error: null },
    });

    render(await AdminPage());

    expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Storage usage could not be loaded.");
    expect(screen.queryByTestId("admin-storage-table")).not.toBeInTheDocument();
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      extra: { where: "admin-page:admin_storage_usage" },
    });
  });

  it("keeps storage quotas when notes usage can't be loaded", async () => {
    const failure = { message: "boom", code: "XX000" };
    mockRpcs({
      storage: { data: STORAGE_ROWS, error: null },
      content: { data: null, error: failure },
    });

    render(await AdminPage());

    expect(screen.getByText(/^1 inactive/)).toBeInTheDocument();
    const table = within(screen.getByTestId("admin-storage-table"));
    const approvedRow = within(table.getByText("approved@example.com").closest("tr")!);
    expect(approvedRow.getByText("Current: 50 MB")).toBeInTheDocument();
    expect(approvedRow.getByText("Unavailable")).toBeInTheDocument();
    expect(table.queryByLabelText(/^Notes quota in MB for/)).not.toBeInTheDocument();
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      extra: { where: "admin-page:admin_content_usage" },
    });
  });

  it("puts inactive accounts and active ones in their own sections, admins without Suspend", async () => {
    mockRpcs({
      storage: { data: STORAGE_ROWS, error: null },
      content: { data: CONTENT_ROWS, error: null },
    });

    render(await AdminPage());

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Admin — Accounts");
    const inactive = within(screen.getByTestId("admin-inactive-accounts"));
    expect(inactive.getByText("pending@example.com")).toBeInTheDocument();
    expect(inactive.getByRole("button", { name: "Activate" })).toBeInTheDocument();

    const active = within(screen.getByTestId("admin-active-accounts"));
    const approvedRow = within(active.getByText("approved@example.com").closest("li")!);
    expect(approvedRow.getByRole("button", { name: "Suspend" })).toBeInTheDocument();
    const adminRow = within(active.getByText("admin@example.com").closest("li")!);
    expect(adminRow.queryByRole("button")).not.toBeInTheDocument();
    expect(adminRow.getByText("Admin")).toBeInTheDocument();
  });
});
