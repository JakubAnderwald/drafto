import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createAdminClient } from "@/lib/supabase/admin";

const captureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
}));

const { listAdminEmails } = await import("@/lib/auth/list-admin-emails");

type Users = Record<string, { email?: string } | Error>;

function fakeAdmin(
  profiles: { data: { id: string }[] | null; error: Error | null },
  users: Users = {},
) {
  const eq = vi.fn(async () => profiles);
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const getUserById = vi.fn(async (id: string) => {
    const user = users[id];
    if (user instanceof Error) return { data: { user: null }, error: user };
    return { data: { user: user ?? null }, error: null };
  });
  const client = { from, auth: { admin: { getUserById } } };
  return {
    client: client as unknown as ReturnType<typeof createAdminClient>,
    from,
    eq,
    getUserById,
  };
}

beforeEach(() => captureException.mockReset());

describe("listAdminEmails", () => {
  it("returns nothing when there are no admins", async () => {
    const { client, from, eq } = fakeAdmin({ data: [], error: null });
    expect(await listAdminEmails(client)).toEqual({ emails: [], failed: false });
    expect(from).toHaveBeenCalledWith("profiles");
    expect(eq).toHaveBeenCalledWith("is_admin", true);
  });

  it("returns one admin's email", async () => {
    const { client } = fakeAdmin({ data: [{ id: "a" }], error: null }, { a: { email: "a@x.eu" } });
    expect(await listAdminEmails(client)).toEqual({ emails: ["a@x.eu"], failed: false });
  });

  it("returns several, each once, skipping one that can't be read", async () => {
    const { client } = fakeAdmin(
      { data: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], error: null },
      {
        a: { email: "a@x.eu" },
        b: new Error("gone"),
        c: { email: "a@x.eu" },
        d: { email: "d@x.eu" },
      },
    );
    expect(await listAdminEmails(client)).toEqual({ emails: ["a@x.eu", "d@x.eu"], failed: false });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("reports failed when there are admins but no email could be read", async () => {
    const { client } = fakeAdmin(
      { data: [{ id: "a" }, { id: "b" }], error: null },
      { a: new Error("auth down"), b: new Error("auth down") },
    );
    expect(await listAdminEmails(client)).toEqual({ emails: [], failed: true });
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("skips an admin without an email", async () => {
    const { client } = fakeAdmin({ data: [{ id: "a" }], error: null }, { a: {} });
    expect(await listAdminEmails(client)).toEqual({ emails: [], failed: false });
  });

  it("reports a failed profiles query as failed", async () => {
    const { client, getUserById } = fakeAdmin({ data: null, error: new Error("db down") });
    expect(await listAdminEmails(client)).toEqual({ emails: [], failed: true });
    expect(getUserById).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: { where: "listAdminEmails:profiles" },
    });
  });
});
