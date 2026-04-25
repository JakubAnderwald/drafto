import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const { AdminUserList } = await import("@/app/(app)/admin/admin-user-list");

describe("AdminUserList", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders empty state when no users", () => {
    render(<AdminUserList initialUsers={[]} />);
    expect(screen.getByText(/No pending users to approve/)).toBeInTheDocument();
  });

  it("shows pending user email and formatted time", () => {
    render(
      <AdminUserList
        initialUsers={[
          {
            id: "u-1",
            email: "pending@example.com",
            display_name: "Pending User",
            created_at: "2026-04-20T11:30:00Z",
          },
        ]}
      />,
    );
    expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Pending User/)).toBeInTheDocument();
    expect(screen.getByText(/30m ago/)).toBeInTheDocument();
  });

  it("formats times across ranges", () => {
    render(
      <AdminUserList
        initialUsers={[
          {
            id: "u-1",
            email: "justnow@example.com",
            display_name: null,
            created_at: "2026-04-20T11:59:30Z",
          },
          {
            id: "u-2",
            email: "hours@example.com",
            display_name: null,
            created_at: "2026-04-20T08:00:00Z",
          },
          {
            id: "u-3",
            email: "days@example.com",
            display_name: null,
            created_at: "2026-04-18T12:00:00Z",
          },
        ]}
      />,
    );
    expect(screen.getByText(/just now/)).toBeInTheDocument();
    expect(screen.getByText(/4h ago/)).toBeInTheDocument();
    expect(screen.getByText(/2d ago/)).toBeInTheDocument();
  });

  it("removes user from list after successful approve", async () => {
    vi.useRealTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminUserList
        initialUsers={[
          {
            id: "u-1",
            email: "pending@example.com",
            display_name: null,
            created_at: "2026-04-20T11:30:00Z",
          },
        ]}
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Approve" }));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/approve-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-1" }),
    });
    expect(screen.queryByText("pending@example.com")).not.toBeInTheDocument();
  });
});
