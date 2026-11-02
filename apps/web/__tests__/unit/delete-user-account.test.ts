import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

const { deleteUserAccount } = await import("@/lib/account/delete-user");

const USER_ID = "bbbbbbbb-0000-4000-8000-000000000002";

interface Entry {
  name: string;
  id: string | null;
}

const listMock = vi.fn();
const removeMock = vi.fn();
const storageFromMock = vi.fn(() => ({ list: listMock, remove: removeMock }));
const deleteUserMock = vi.fn();
const admin = {
  auth: { admin: { deleteUser: deleteUserMock } },
  storage: { from: storageFromMock },
} as unknown as SupabaseClient<Database>;

const folder = (name: string): Entry => ({ name, id: null });
const file = (name: string): Entry => ({ name, id: `id-${name}` });

/**
 * Serves `list(prefix, { limit, offset })` from an in-memory folder tree whose
 * files disappear once `remove()` has been called on them, like real Storage.
 */
function mockTree(tree: Record<string, Entry[]>) {
  const removed = new Set<string>();
  removeMock.mockImplementation((paths: string[]) => {
    paths.forEach((path) => removed.add(path));
    return Promise.resolve({ data: [], error: null });
  });
  listMock.mockImplementation((prefix: string, options: { limit: number; offset: number }) =>
    Promise.resolve({
      data: (tree[prefix] ?? [])
        .filter((entry) => entry.id === null || !removed.has(`${prefix}/${entry.name}`))
        .slice(options.offset, options.offset + options.limit),
      error: null,
    }),
  );
}

describe("deleteUserAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTree({});
    deleteUserMock.mockResolvedValue({ data: { user: null }, error: null });
  });

  it("sweeps storage strictly, then deletes the auth user, then sweeps again", async () => {
    mockTree({
      [USER_ID]: [folder("note-1")],
      [`${USER_ID}/note-1`]: [file("a.png"), file("b.pdf")],
    });

    await expect(deleteUserAccount(admin, USER_ID)).resolves.toEqual({ ok: true });

    expect(storageFromMock).toHaveBeenCalledWith("attachments");
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith([`${USER_ID}/note-1/a.png`, `${USER_ID}/note-1/b.pdf`]);
    expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);

    const deleteOrder = deleteUserMock.mock.invocationCallOrder[0];
    const listOrders = listMock.mock.invocationCallOrder;
    expect(removeMock.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
    expect(listOrders[0]).toBeLessThan(deleteOrder);
    // The best-effort sweep re-lists the user's folder after the auth user is gone.
    expect(listOrders.at(-1)).toBeGreaterThan(deleteOrder);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("removes an upload that landed between the strict sweep and deleteUser", async () => {
    const tree: Record<string, Entry[]> = { [USER_ID]: [] };
    mockTree(tree);
    deleteUserMock.mockImplementation(() => {
      tree[USER_ID] = [folder("note-late")];
      tree[`${USER_ID}/note-late`] = [file("late.png")];
      return Promise.resolve({ data: { user: null }, error: null });
    });

    await expect(deleteUserAccount(admin, USER_ID)).resolves.toEqual({ ok: true });

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith([`${USER_ID}/note-late/late.png`]);
  });

  it("fully removes a user with more than 100 files", async () => {
    const files = Array.from({ length: 1234 }, (_, i) => file(`f-${i}.png`));
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: files });

    await expect(deleteUserAccount(admin, USER_ID)).resolves.toEqual({ ok: true });

    const removed = removeMock.mock.calls.flatMap(([paths]) => paths as string[]);
    expect(new Set(removed)).toEqual(new Set(files.map((f) => `${USER_ID}/note-1/${f.name}`)));
    // Everything was removed before the auth user was deleted.
    const removesBeforeDelete = removeMock.mock.invocationCallOrder.filter(
      (order) => order < deleteUserMock.mock.invocationCallOrder[0],
    );
    expect(removesBeforeDelete).toHaveLength(removeMock.mock.calls.length);
  });

  it("returns the storage stage, reports to Sentry and keeps the auth user when listing fails", async () => {
    const listError = new Error("list failed");
    listMock.mockResolvedValue({ data: null, error: listError });

    await expect(deleteUserAccount(admin, USER_ID)).resolves.toEqual({
      ok: false,
      stage: "storage",
    });

    expect(deleteUserMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(listError, {
      extra: { where: "delete-user-account:storage", userId: USER_ID },
    });
  });

  it("returns the storage stage and keeps the auth user when a remove fails", async () => {
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: [file("a.png")] });
    const removeError = new Error("remove failed");
    removeMock.mockResolvedValue({ data: null, error: removeError });

    await expect(deleteUserAccount(admin, USER_ID)).resolves.toEqual({
      ok: false,
      stage: "storage",
    });

    expect(deleteUserMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(removeError, {
      extra: { where: "delete-user-account:storage", userId: USER_ID },
    });
  });

  it("returns the auth stage and reports to Sentry when deleteUser returns an error", async () => {
    const deleteError = new Error("Database error deleting user");
    deleteUserMock.mockResolvedValue({ data: null, error: deleteError });

    await expect(deleteUserAccount(admin, USER_ID)).resolves.toEqual({ ok: false, stage: "auth" });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(deleteError, {
      extra: { where: "delete-user-account:deleteUser", userId: USER_ID },
    });
    // No best-effort sweep after a failed delete: the strict sweep is the only listing.
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("returns the auth stage and reports to Sentry when deleteUser throws", async () => {
    const thrown = new Error("network down");
    deleteUserMock.mockRejectedValue(thrown);

    await expect(deleteUserAccount(admin, USER_ID)).resolves.toEqual({ ok: false, stage: "auth" });

    expect(captureExceptionMock).toHaveBeenCalledWith(thrown, {
      extra: { where: "delete-user-account:deleteUser", userId: USER_ID },
    });
  });

  it("still succeeds when the best-effort sweep fails after the user is gone", async () => {
    const listError = new Error("list failed late");
    listMock
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: null, error: listError });

    await expect(deleteUserAccount(admin, USER_ID)).resolves.toEqual({ ok: true });

    expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
    expect(captureExceptionMock).toHaveBeenCalledWith(listError, {
      extra: { where: "remove-user-attachments:list", userId: USER_ID },
    });
  });
});
