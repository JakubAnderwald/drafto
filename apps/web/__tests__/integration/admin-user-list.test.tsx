import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

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

describe("AdminUserList — pending count and delete", () => {
  const users = [
    {
      id: "u-1",
      email: "spam@example.com",
      display_name: null,
      created_at: "2026-04-20T11:30:00Z",
    },
    {
      id: "u-2",
      email: "keep@example.com",
      display_name: null,
      created_at: "2026-04-20T11:00:00Z",
    },
  ];

  function rowFor(email: string): HTMLElement {
    const row = screen.getByText(email).closest("li");
    if (!row) throw new Error(`no row for ${email}`);
    return row;
  }

  /** A row's own action button — the inline confirm dialog also has a "Delete" button. */
  function rowAction(email: string, name: string): HTMLElement {
    const [button, ...rest] = within(rowFor(email))
      .getAllByRole("button", { name })
      .filter((b) => !b.closest('[role="alertdialog"]'));
    if (!button || rest.length > 0) throw new Error(`expected one "${name}" button for ${email}`);
    return button;
  }

  function dialogAction(name: string): HTMLElement {
    return within(screen.getByRole("alertdialog")).getByRole("button", { name });
  }

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    captureExceptionMock.mockClear();
  });

  it("shows the pending count, including zero", () => {
    const { unmount } = render(<AdminUserList initialUsers={users} />);
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    unmount();

    render(<AdminUserList initialUsers={[]} />);
    expect(screen.getByText("0 pending")).toBeInTheDocument();
  });

  it("renders a Delete button directly after Approve on each row", () => {
    render(<AdminUserList initialUsers={users} />);

    for (const { email } of users) {
      const buttons = within(rowFor(email)).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(["Approve", "Delete"]);
    }
  });

  it("opens a confirm dialog naming the user, and Cancel closes it without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("spam@example.com", "Delete"));

    const dialog = screen.getByRole("alertdialog", { name: "Delete user?" });
    expect(within(rowFor("spam@example.com")).getByRole("alertdialog")).toBe(dialog);
    expect(dialog).toHaveTextContent(
      "This permanently deletes spam@example.com and all of their data. This cannot be undone.",
    );

    await user.click(dialogAction("Cancel"));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("spam@example.com")).toBeInTheDocument();
    expect(screen.getByText("2 pending")).toBeInTheDocument();
  });

  it("deletes the user on confirm, showing a loading state until the row disappears", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("spam@example.com", "Delete"));
    await user.click(dialogAction("Delete"));

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/delete-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-1" }),
    });
    expect(rowAction("spam@example.com", "Deleting...")).toBeDisabled();
    expect(rowAction("spam@example.com", "Approve")).toBeDisabled();
    expect(dialogAction("Delete")).toBeDisabled();
    // Cancel is ignored while the request is in flight.
    await user.click(dialogAction("Cancel"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    // Another row's Delete can't open a second dialog mid-request; its Approve still works.
    expect(rowAction("keep@example.com", "Delete")).toBeDisabled();
    expect(rowAction("keep@example.com", "Approve")).toBeEnabled();

    await act(async () => {
      resolveFetch(jsonResponse({ success: true }, 200));
    });

    expect(screen.queryByText("spam@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("keep@example.com")).toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(rowAction("keep@example.com", "Delete")).toBeEnabled();
  });

  it("keeps the dialog open and shows the API error when the delete is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Only pending users can be deleted" }, 409)),
    );
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("spam@example.com", "Delete"));
    await user.click(dialogAction("Delete"));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Only pending users can be deleted",
    );
    expect(screen.getByText("spam@example.com")).toBeInTheDocument();
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    expect(rowAction("spam@example.com", "Delete")).toBeEnabled();
    expect(rowAction("spam@example.com", "Approve")).toBeEnabled();
    expect(dialogAction("Delete")).toBeEnabled();
    // The server already reports its own failures; the client only reports requests that never got a response.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("shows a generic error when the failure response has no error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 })),
    );
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("spam@example.com", "Delete"));
    await user.click(dialogAction("Delete"));

    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "Failed to delete user. Please try again.",
    );
  });

  it("shows a generic error when the request fails, and clears it when the dialog is reopened", async () => {
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("spam@example.com", "Delete"));
    await user.click(dialogAction("Delete"));

    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "Failed to delete user. Please try again.",
    );
    expect(captureExceptionMock).toHaveBeenCalledWith(networkError, {
      extra: { where: "admin-user-list:confirmDelete", userId: "u-1" },
    });

    await user.click(dialogAction("Cancel"));
    await user.click(rowAction("spam@example.com", "Delete"));

    expect(within(screen.getByRole("alertdialog")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("moves the dialog when Delete is clicked on another row", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("spam@example.com", "Delete"));
    await user.click(rowAction("keep@example.com", "Delete"));

    const dialogs = screen.getAllByRole("alertdialog");
    expect(dialogs).toHaveLength(1);
    expect(within(rowFor("keep@example.com")).getByRole("alertdialog")).toBe(dialogs[0]);
    expect(dialogs[0]).toHaveTextContent("keep@example.com");
  });

  it("closes that row's dialog as soon as an approve starts, then updates the count", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("spam@example.com", "Delete"));
    await user.click(rowAction("spam@example.com", "Approve"));

    // The approve is still in flight: no delete can be confirmed or re-opened meanwhile.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(rowAction("spam@example.com", "Delete")).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/approve-user", expect.anything());

    await act(async () => {
      resolveFetch(jsonResponse({ success: true }, 200));
    });

    expect(screen.queryByText("spam@example.com")).not.toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
  });

  it("keeps a row locked while its approve is in flight, even if another approve finishes first", async () => {
    const pending = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.set(JSON.parse(String(init.body)).userId, resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("spam@example.com", "Approve"));
    await user.click(rowAction("keep@example.com", "Approve"));

    await act(async () => {
      pending.get("u-2")?.(jsonResponse({ success: true }, 200));
    });

    expect(screen.queryByText("keep@example.com")).not.toBeInTheDocument();
    expect(rowAction("spam@example.com", "Approving...")).toBeDisabled();
    expect(rowAction("spam@example.com", "Delete")).toBeDisabled();

    await act(async () => {
      pending.get("u-1")?.(jsonResponse({ error: "Failed to approve user" }, 500));
    });

    expect(rowAction("spam@example.com", "Approve")).toBeEnabled();
    expect(rowAction("spam@example.com", "Delete")).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves another row's open dialog alone when a different row is approved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true }, 200)));
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={users} />);

    await user.click(rowAction("keep@example.com", "Delete"));
    await user.click(rowAction("spam@example.com", "Approve"));

    expect(screen.queryByText("spam@example.com")).not.toBeInTheDocument();
    expect(within(rowFor("keep@example.com")).getByRole("alertdialog")).toBeInTheDocument();
  });
});
