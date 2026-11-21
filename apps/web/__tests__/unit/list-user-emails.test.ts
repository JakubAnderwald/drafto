import { beforeEach, describe, expect, it, vi } from "vitest";

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

const { listUserEmails } = await import("@/lib/auth/list-user-emails");

type Page = { data: { users: { id: string; email?: string }[] }; error: unknown };

function adminWith(pages: Page[]) {
  const listUsers = vi.fn(async ({ page }: { page: number; perPage: number }) => pages[page - 1]);
  const admin = { auth: { admin: { listUsers } } } as unknown as Parameters<
    typeof listUserEmails
  >[0];
  return { admin, listUsers };
}

function users(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `u-${offset + i}`,
    email: `user${offset + i}@example.com`,
  }));
}

describe("listUserEmails", () => {
  beforeEach(() => captureExceptionMock.mockClear());

  it("maps every user's id to their email in one page when there are fewer than 1000", async () => {
    const { admin, listUsers } = adminWith([
      { data: { users: [...users(2), { id: "no-email" }] }, error: null },
    ]);

    const emails = await listUserEmails(admin);

    expect(listUsers).toHaveBeenCalledTimes(1);
    expect(listUsers).toHaveBeenCalledWith({ page: 1, perPage: 1000 });
    expect(Object.fromEntries(emails)).toEqual({
      "u-0": "user0@example.com",
      "u-1": "user1@example.com",
    });
  });

  it("pages until a short page", async () => {
    const { admin, listUsers } = adminWith([
      { data: { users: users(1000) }, error: null },
      { data: { users: users(3, 1000) }, error: null },
    ]);

    const emails = await listUserEmails(admin);

    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(listUsers).toHaveBeenLastCalledWith({ page: 2, perPage: 1000 });
    expect(emails.size).toBe(1003);
    expect(emails.get("u-1002")).toBe("user1002@example.com");
  });

  it("reports a failed page and keeps what it already has", async () => {
    const failure = { message: "rate limited" };
    const { admin } = adminWith([
      { data: { users: users(1000) }, error: null },
      { data: { users: [] }, error: failure },
    ]);

    const emails = await listUserEmails(admin);

    expect(emails.size).toBe(1000);
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      extra: { where: "listUserEmails", page: 2 },
    });
  });
});
