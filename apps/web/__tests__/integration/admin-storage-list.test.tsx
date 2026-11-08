import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_STORAGE_QUOTA_BYTES, megabytesToBytes } from "@drafto/shared";

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

const { AdminStorageList } = await import("@/app/(app)/admin/admin-storage-list");

const ALICE = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "alice@example.com",
  usedBytes: megabytesToBytes(12.4),
  quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
};

const ADMIN = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "admin@example.com",
  usedBytes: megabytesToBytes(80),
  quotaBytes: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rowFor(email: string): HTMLElement {
  const row = screen.getByText(email).closest("tr");
  if (!row) throw new Error(`No row for ${email}`);
  return row;
}

describe("AdminStorageList", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    captureExceptionMock.mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the Storage used and Quota columns with each user's numbers", () => {
    render(<AdminStorageList users={[ALICE, ADMIN]} />);

    expect(screen.getByRole("columnheader", { name: "Storage used" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Quota" })).toBeInTheDocument();

    const alice = within(rowFor(ALICE.email));
    expect(alice.getByText("12.4 MB")).toBeInTheDocument();
    expect(alice.getByText("Current: 50 MB")).toBeInTheDocument();
    expect(alice.getByLabelText(`Quota in MB for ${ALICE.email}`)).toHaveValue(50);
    expect(alice.getByLabelText(`Unlimited storage for ${ALICE.email}`)).not.toBeChecked();

    const admin = within(rowFor(ADMIN.email));
    expect(admin.getByText("80 MB")).toBeInTheDocument();
    expect(admin.getByText("Current: Unlimited")).toBeInTheDocument();
    expect(admin.getByLabelText(`Unlimited storage for ${ADMIN.email}`)).toBeChecked();
    expect(admin.getByLabelText(`Quota in MB for ${ADMIN.email}`)).toBeDisabled();
  });

  it("shows an empty state with no users", () => {
    render(<AdminStorageList users={[]} />);
    expect(screen.getByText("No users.")).toBeInTheDocument();
  });

  it("saves an edited quota in MB and shows the new value", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { userId: ALICE.id, quotaBytes: megabytesToBytes(200) }),
    );
    render(<AdminStorageList users={[ALICE]} />);

    const row = within(rowFor(ALICE.email));
    const input = row.getByLabelText(`Quota in MB for ${ALICE.email}`);
    await user.clear(input);
    await user.type(input, "200");
    await user.click(row.getByRole("button", { name: `Save quota for ${ALICE.email}` }));

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/storage-quota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: ALICE.id, quotaMb: 200 }),
    });
    expect(await row.findByRole("status")).toHaveTextContent("Saved");
    expect(row.getByText("Current: 200 MB")).toBeInTheDocument();
  });

  it("saves Unlimited as a null quota", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { userId: ALICE.id, quotaBytes: null }));
    render(<AdminStorageList users={[ALICE]} />);

    const row = within(rowFor(ALICE.email));
    await user.click(row.getByLabelText(`Unlimited storage for ${ALICE.email}`));
    expect(row.getByLabelText(`Quota in MB for ${ALICE.email}`)).toBeDisabled();
    await user.click(row.getByRole("button", { name: `Save quota for ${ALICE.email}` }));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      userId: ALICE.id,
      quotaMb: null,
    });
    expect(await row.findByRole("status")).toHaveTextContent("Saved");
    expect(row.getByText("Current: Unlimited")).toBeInTheDocument();
  });

  it("unticking Unlimited offers the default quota", async () => {
    const user = userEvent.setup();
    render(<AdminStorageList users={[ADMIN]} />);

    const row = within(rowFor(ADMIN.email));
    await user.click(row.getByLabelText(`Unlimited storage for ${ADMIN.email}`));

    const input = row.getByLabelText(`Quota in MB for ${ADMIN.email}`);
    expect(input).toBeEnabled();
    expect(input).toHaveValue(50);
  });

  it("refuses a quota that isn't a positive whole number without calling the API", async () => {
    const user = userEvent.setup();
    render(<AdminStorageList users={[ALICE]} />);

    const row = within(rowFor(ALICE.email));
    await user.clear(row.getByLabelText(`Quota in MB for ${ALICE.email}`));
    await user.click(row.getByRole("button", { name: `Save quota for ${ALICE.email}` }));

    expect(await row.findByRole("alert")).toHaveTextContent(/whole number of MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the API's error inline and keeps the old quota", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "Forbidden", status: 403 }));
    render(<AdminStorageList users={[ALICE]} />);

    const row = within(rowFor(ALICE.email));
    await user.click(row.getByRole("button", { name: `Save quota for ${ALICE.email}` }));

    expect(await row.findByRole("alert")).toHaveTextContent("Forbidden");
    expect(row.getByText("Current: 50 MB")).toBeInTheDocument();
    expect(row.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a network failure to Sentry and shows a generic error", async () => {
    const user = userEvent.setup();
    const failure = new Error("network down");
    fetchMock.mockRejectedValue(failure);
    render(<AdminStorageList users={[ALICE]} />);

    const row = within(rowFor(ALICE.email));
    await user.click(row.getByRole("button", { name: `Save quota for ${ALICE.email}` }));

    expect(await row.findByRole("alert")).toHaveTextContent("Failed to save the quota");
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      extra: { where: "admin-storage-list:save", userId: ALICE.id },
    });
  });

  it("colours usage at or over the quota as danger", () => {
    render(
      <AdminStorageList
        users={[
          {
            ...ALICE,
            usedBytes: DEFAULT_STORAGE_QUOTA_BYTES,
            quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
          },
        ]}
      />,
    );

    expect(within(rowFor(ALICE.email)).getByText("50 MB", { selector: "td" })).toHaveClass(
      "text-error-text",
    );
  });
});
