import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import type { AdminAccount } from "@/app/(app)/admin/admin-user-list";

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

function account(overrides: Partial<AdminAccount> & Pick<AdminAccount, "id" | "email">) {
  return {
    display_name: null,
    created_at: "2026-04-20T11:30:00Z",
    is_active: false,
    is_admin: false,
    ...overrides,
  } satisfies AdminAccount;
}

const SPAM = account({ id: "u-1", email: "spam@example.com" });
const KEEP = account({ id: "u-2", email: "keep@example.com", created_at: "2026-04-20T11:00:00Z" });
const ACTIVE = account({ id: "u-3", email: "active@example.com", is_active: true });
const ADMIN = account({ id: "u-4", email: "admin@example.com", is_active: true, is_admin: true });

function rowFor(email: string): HTMLElement {
  const row = screen.getByText(email).closest("li");
  if (!row) throw new Error(`no row for ${email}`);
  return row;
}

/** A row's own action button — the inline confirm dialog has its own buttons. */
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

function section(testId: "admin-inactive-accounts" | "admin-active-accounts") {
  return within(screen.getByTestId(testId));
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch whose responses are released by hand, keyed by the request's userId. */
function deferredFetch() {
  const pending = new Map<string, (response: Response) => void>();
  const fetchMock = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.set(JSON.parse(String(init.body)).userId, resolve);
      }),
  );
  return { fetchMock, pending };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  captureExceptionMock.mockClear();
});

describe("AdminUserList — rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:00:00Z"));
  });

  it("renders both empty states and zero counts", () => {
    render(<AdminUserList initialUsers={[]} />);
    expect(screen.getByText("No inactive accounts.")).toBeInTheDocument();
    expect(screen.getByText("No active accounts.")).toBeInTheDocument();
    expect(screen.getByText(/^0 inactive/)).toBeInTheDocument();
    expect(screen.getByText("0 active")).toBeInTheDocument();
  });

  it("shows each account's email, name and signup time", () => {
    render(
      <AdminUserList
        initialUsers={[
          account({ id: "u-1", email: "pending@example.com", display_name: "Pending User" }),
          account({
            id: "u-2",
            email: "hours@example.com",
            created_at: "2026-04-20T08:00:00Z",
            is_active: true,
          }),
          account({ id: "u-3", email: "days@example.com", created_at: "2026-04-18T12:00:00Z" }),
        ]}
      />,
    );
    expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Pending User/)).toBeInTheDocument();
    expect(screen.getByText(/30m ago/)).toBeInTheDocument();
    expect(screen.getByText(/4h ago/)).toBeInTheDocument();
    expect(screen.getByText(/2d ago/)).toBeInTheDocument();
  });

  it("splits accounts into sections with their own actions; admins get none", () => {
    render(<AdminUserList initialUsers={[SPAM, KEEP, ACTIVE, ADMIN]} />);

    expect(screen.getByText(/^2 inactive/)).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();

    for (const { email } of [SPAM, KEEP]) {
      expect(section("admin-inactive-accounts").getByText(email)).toBeInTheDocument();
      const buttons = within(rowFor(email)).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(["Activate", "Delete"]);
    }

    expect(section("admin-active-accounts").getByText(ACTIVE.email)).toBeInTheDocument();
    expect(
      within(rowFor(ACTIVE.email))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Suspend"]);

    expect(within(rowFor(ADMIN.email)).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rowFor(ADMIN.email)).getByText("Admin")).toBeInTheDocument();
  });
});

describe("AdminUserList — activate", () => {
  it("moves the account to the active section after a successful activate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }, 200));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM]} />);

    await user.click(rowAction(SPAM.email, "Activate"));

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/approve-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-1" }),
    });
    expect(section("admin-active-accounts").getByText(SPAM.email)).toBeInTheDocument();
    expect(rowAction(SPAM.email, "Suspend")).toBeEnabled();
    expect(screen.getByText(/^0 inactive/)).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
  });

  it("leaves the account inactive when the activate is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500)));
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM]} />);

    await user.click(rowAction(SPAM.email, "Activate"));

    expect(section("admin-inactive-accounts").getByText(SPAM.email)).toBeInTheDocument();
    expect(rowAction(SPAM.email, "Activate")).toBeEnabled();
    expect(within(rowFor(SPAM.email)).getByRole("alert")).toHaveTextContent("nope");
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("reports an activate that never got a response, and leaves the row usable", async () => {
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM]} />);

    await user.click(rowAction(SPAM.email, "Activate"));

    expect(captureExceptionMock).toHaveBeenCalledWith(networkError, {
      extra: { where: "admin-user-list:activate", userId: "u-1" },
    });
    expect(rowAction(SPAM.email, "Activate")).toBeEnabled();
    expect(within(rowFor(SPAM.email)).getByRole("alert")).toHaveTextContent(
      "Failed to activate user. Please try again.",
    );
  });

  it("closes that row's delete dialog as soon as an activate starts", async () => {
    const { fetchMock, pending } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM, KEEP]} />);

    await user.click(rowAction(SPAM.email, "Delete"));
    await user.click(rowAction(SPAM.email, "Activate"));

    // The activate is still in flight: no delete can be confirmed or re-opened meanwhile.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(rowAction(SPAM.email, "Delete")).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.get("u-1")?.(jsonResponse({ success: true }, 200));
    });

    expect(section("admin-active-accounts").getByText(SPAM.email)).toBeInTheDocument();
  });

  it("keeps a row locked while its activate is in flight, even if another finishes first", async () => {
    const { fetchMock, pending } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM, KEEP]} />);

    await user.click(rowAction(SPAM.email, "Activate"));
    await user.click(rowAction(KEEP.email, "Activate"));

    await act(async () => {
      pending.get("u-2")?.(jsonResponse({ success: true }, 200));
    });

    expect(section("admin-active-accounts").getByText(KEEP.email)).toBeInTheDocument();
    expect(rowAction(SPAM.email, "Activating...")).toBeDisabled();
    expect(rowAction(SPAM.email, "Delete")).toBeDisabled();

    await act(async () => {
      pending.get("u-1")?.(jsonResponse({ error: "Failed to activate user" }, 500));
    });

    expect(rowAction(SPAM.email, "Activate")).toBeEnabled();
    expect(rowAction(SPAM.email, "Delete")).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves another row's open dialog alone when a different row is activated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true }, 200)));
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM, KEEP]} />);

    await user.click(rowAction(KEEP.email, "Delete"));
    await user.click(rowAction(SPAM.email, "Activate"));

    expect(section("admin-active-accounts").getByText(SPAM.email)).toBeInTheDocument();
    expect(within(rowFor(KEEP.email)).getByRole("alertdialog")).toBeInTheDocument();
  });
});

describe("AdminUserList — suspend", () => {
  it("asks first, naming the user and saying nothing is deleted; Cancel sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[ACTIVE]} />);

    await user.click(rowAction(ACTIVE.email, "Suspend"));

    const dialog = screen.getByRole("alertdialog", { name: "Suspend user?" });
    expect(dialog).toHaveTextContent(
      "active@example.com loses access to their notes on every device until you reactivate them. Nothing is deleted.",
    );

    await user.click(dialogAction("Cancel"));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moves the account to the inactive section once the suspend succeeds", async () => {
    const { fetchMock, pending } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[ACTIVE, SPAM]} />);

    await user.click(rowAction(ACTIVE.email, "Suspend"));
    await user.click(dialogAction("Suspend"));

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/suspend-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-3" }),
    });
    expect(rowAction(ACTIVE.email, "Suspending...")).toBeDisabled();
    // One confirmed action at a time: another row's Delete waits.
    expect(rowAction(SPAM.email, "Delete")).toBeDisabled();
    expect(rowAction(SPAM.email, "Activate")).toBeEnabled();

    await act(async () => {
      pending.get("u-3")?.(jsonResponse({ success: true }, 200));
    });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(section("admin-inactive-accounts").getByText(ACTIVE.email)).toBeInTheDocument();
    expect(rowAction(ACTIVE.email, "Activate")).toBeEnabled();
    expect(screen.getByText(/^2 inactive/)).toBeInTheDocument();
    expect(screen.getByText("0 active")).toBeInTheDocument();
  });

  it("keeps the dialog open with the API error when the suspend is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Admin accounts cannot be suspended" }, 409)),
    );
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[ACTIVE]} />);

    await user.click(rowAction(ACTIVE.email, "Suspend"));
    await user.click(dialogAction("Suspend"));

    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "Admin accounts cannot be suspended",
    );
    expect(section("admin-active-accounts").getByText(ACTIVE.email)).toBeInTheDocument();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("shows a generic error and reports it when the suspend request fails", async () => {
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[ACTIVE]} />);

    await user.click(rowAction(ACTIVE.email, "Suspend"));
    await user.click(dialogAction("Suspend"));

    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "Failed to suspend user. Please try again.",
    );
    expect(captureExceptionMock).toHaveBeenCalledWith(networkError, {
      extra: { where: "admin-user-list:suspend", userId: "u-3" },
    });
  });
});

describe("AdminUserList — delete", () => {
  it("opens a confirm dialog naming the user, and Cancel closes it without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM, KEEP]} />);

    await user.click(rowAction(SPAM.email, "Delete"));

    const dialog = screen.getByRole("alertdialog", { name: "Delete user?" });
    expect(within(rowFor(SPAM.email)).getByRole("alertdialog")).toBe(dialog);
    expect(dialog).toHaveTextContent(
      "This permanently deletes spam@example.com and all of their data. This cannot be undone. Only an account with no notebooks, notes or API keys can be deleted here.",
    );

    await user.click(dialogAction("Cancel"));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/^2 inactive/)).toBeInTheDocument();
  });

  it("deletes the user on confirm, showing a loading state until the row disappears", async () => {
    const { fetchMock, pending } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM, KEEP, ACTIVE]} />);

    await user.click(rowAction(SPAM.email, "Delete"));
    await user.click(dialogAction("Delete"));

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/delete-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-1" }),
    });
    expect(rowAction(SPAM.email, "Deleting...")).toBeDisabled();
    expect(rowAction(SPAM.email, "Activate")).toBeDisabled();
    expect(dialogAction("Delete")).toBeDisabled();
    // Cancel is ignored while the request is in flight.
    await user.click(dialogAction("Cancel"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    // No second confirmation can open mid-request; another row's Activate still works.
    expect(rowAction(KEEP.email, "Delete")).toBeDisabled();
    expect(rowAction(ACTIVE.email, "Suspend")).toBeDisabled();
    expect(rowAction(KEEP.email, "Activate")).toBeEnabled();

    await act(async () => {
      pending.get("u-1")?.(jsonResponse({ success: true }, 200));
    });

    expect(screen.queryByText(SPAM.email)).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText(/^1 inactive/)).toBeInTheDocument();
    expect(rowAction(KEEP.email, "Delete")).toBeEnabled();
  });

  it("keeps the dialog open and shows the API error when the delete is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: "Only pending users can be deleted: this account already has data" },
            409,
          ),
        ),
    );
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM]} />);

    await user.click(rowAction(SPAM.email, "Delete"));
    await user.click(dialogAction("Delete"));

    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "this account already has data",
    );
    expect(screen.getByText(SPAM.email)).toBeInTheDocument();
    expect(rowAction(SPAM.email, "Delete")).toBeEnabled();
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
    render(<AdminUserList initialUsers={[SPAM]} />);

    await user.click(rowAction(SPAM.email, "Delete"));
    await user.click(dialogAction("Delete"));

    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "Failed to delete user. Please try again.",
    );
  });

  it("shows a generic error when the request fails, and clears it when the dialog is reopened", async () => {
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM]} />);

    await user.click(rowAction(SPAM.email, "Delete"));
    await user.click(dialogAction("Delete"));

    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "Failed to delete user. Please try again.",
    );
    expect(captureExceptionMock).toHaveBeenCalledWith(networkError, {
      extra: { where: "admin-user-list:delete", userId: "u-1" },
    });

    await user.click(dialogAction("Cancel"));
    await user.click(rowAction(SPAM.email, "Delete"));

    expect(within(screen.getByRole("alertdialog")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("moves the dialog when another row's confirmation is opened", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    render(<AdminUserList initialUsers={[SPAM, ACTIVE]} />);

    await user.click(rowAction(SPAM.email, "Delete"));
    await user.click(rowAction(ACTIVE.email, "Suspend"));

    const dialogs = screen.getAllByRole("alertdialog");
    expect(dialogs).toHaveLength(1);
    expect(within(rowFor(ACTIVE.email)).getByRole("alertdialog")).toBe(dialogs[0]);
    expect(dialogs[0]).toHaveAccessibleName("Suspend user?");
  });
});
