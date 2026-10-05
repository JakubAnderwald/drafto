import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

const { removeAllUserAttachments, removeUserAttachments, LIST_PAGE_SIZE, REMOVE_BATCH_SIZE } =
  await import("@/lib/storage/remove-user-attachments");

const USER_ID = "bbbbbbbb-0000-4000-8000-000000000002";

interface Entry {
  name: string;
  id: string | null;
}

const listMock = vi.fn();
const removeMock = vi.fn();
const storageFromMock = vi.fn(() => ({ list: listMock, remove: removeMock }));
const client = { storage: { from: storageFromMock } } as unknown as SupabaseClient<Database>;

const folder = (name: string): Entry => ({ name, id: null });
const file = (name: string): Entry => ({ name, id: `id-${name}` });

/** Serves `list(prefix, { limit, offset })` from an in-memory folder tree. */
function mockTree(tree: Record<string, Entry[]>) {
  listMock.mockImplementation((prefix: string, options: { limit: number; offset: number }) =>
    Promise.resolve({
      data: (tree[prefix] ?? []).slice(options.offset, options.offset + options.limit),
      error: null,
    }),
  );
}

describe("removeUserAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeMock.mockResolvedValue({ data: [], error: null });
  });

  it("collects files from every note folder into a single remove call", async () => {
    mockTree({
      [USER_ID]: [folder("note-1"), folder("note-2")],
      [`${USER_ID}/note-1`]: [file("a.png"), file("b.pdf")],
      [`${USER_ID}/note-2`]: [file("c.jpg")],
    });

    await removeUserAttachments(client, USER_ID);

    expect(storageFromMock).toHaveBeenCalledWith("attachments");
    expect(listMock).toHaveBeenCalledWith(USER_ID, { limit: LIST_PAGE_SIZE, offset: 0 });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith([
      `${USER_ID}/note-1/a.png`,
      `${USER_ID}/note-1/b.pdf`,
      `${USER_ID}/note-2/c.jpg`,
    ]);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("skips remove when the user has no objects", async () => {
    mockTree({});

    await removeUserAttachments(client, USER_ID);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("pages through folders larger than one list page", async () => {
    const files = Array.from({ length: LIST_PAGE_SIZE + 5 }, (_, i) => file(`f-${i}.png`));
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: files });

    await removeUserAttachments(client, USER_ID);

    expect(listMock).toHaveBeenCalledWith(`${USER_ID}/note-1`, {
      limit: LIST_PAGE_SIZE,
      offset: LIST_PAGE_SIZE,
    });
    const removed = removeMock.mock.calls.flatMap(([paths]) => paths as string[]);
    expect(removed).toHaveLength(files.length);
    expect(removed.at(-1)).toBe(`${USER_ID}/note-1/f-${LIST_PAGE_SIZE + 4}.png`);
  });

  it("removes in batches no larger than the Storage API limit", async () => {
    const files = Array.from({ length: REMOVE_BATCH_SIZE * 2 + 1 }, (_, i) => file(`f-${i}`));
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: files });

    await removeUserAttachments(client, USER_ID);

    expect(removeMock.mock.calls.map(([paths]) => (paths as string[]).length)).toEqual([
      REMOVE_BATCH_SIZE,
      REMOVE_BATCH_SIZE,
      1,
    ]);
  });

  it("reports a list error to Sentry without throwing or removing anything", async () => {
    const listError = new Error("list failed");
    listMock.mockResolvedValue({ data: null, error: listError });

    await expect(removeUserAttachments(client, USER_ID)).resolves.toBeUndefined();

    expect(removeMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(listError, {
      extra: { where: "remove-user-attachments:list", userId: USER_ID },
    });
  });

  it("reports a thrown list error to Sentry without throwing", async () => {
    const thrown = new Error("fetch failed");
    listMock.mockRejectedValue(thrown);

    await expect(removeUserAttachments(client, USER_ID)).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledWith(thrown, {
      extra: { where: "remove-user-attachments:list", userId: USER_ID },
    });
  });

  it("reports a remove error to Sentry and still tries the remaining batches", async () => {
    const files = Array.from({ length: REMOVE_BATCH_SIZE + 1 }, (_, i) => file(`f-${i}`));
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: files });
    const removeError = new Error("remove failed");
    removeMock.mockResolvedValueOnce({ data: null, error: removeError });

    await expect(removeUserAttachments(client, USER_ID)).resolves.toBeUndefined();

    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(removeError, {
      extra: {
        where: "remove-user-attachments:remove",
        userId: USER_ID,
        batchSize: REMOVE_BATCH_SIZE,
      },
    });
  });

  it("reports a thrown remove error to Sentry without throwing", async () => {
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: [file("a.png")] });
    const thrown = new Error("socket hang up");
    removeMock.mockRejectedValue(thrown);

    await expect(removeUserAttachments(client, USER_ID)).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledWith(thrown, {
      extra: { where: "remove-user-attachments:remove", userId: USER_ID, batchSize: 1 },
    });
  });
});

describe("removeAllUserAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeMock.mockResolvedValue({ data: [], error: null });
  });

  it("removes every file from every note folder", async () => {
    mockTree({
      [USER_ID]: [folder("note-1"), folder("note-2")],
      [`${USER_ID}/note-1`]: [file("a.png"), file("b.pdf")],
      [`${USER_ID}/note-2`]: [file("c.jpg")],
    });

    await expect(removeAllUserAttachments(client, USER_ID)).resolves.toBeUndefined();

    expect(storageFromMock).toHaveBeenCalledWith("attachments");
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith([
      `${USER_ID}/note-1/a.png`,
      `${USER_ID}/note-1/b.pdf`,
      `${USER_ID}/note-2/c.jpg`,
    ]);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("skips remove when the user has no objects", async () => {
    mockTree({});

    await removeAllUserAttachments(client, USER_ID);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("pages through folders larger than one list page", async () => {
    const files = Array.from({ length: LIST_PAGE_SIZE + 5 }, (_, i) => file(`f-${i}.png`));
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: files });

    await removeAllUserAttachments(client, USER_ID);

    expect(listMock).toHaveBeenCalledWith(`${USER_ID}/note-1`, {
      limit: LIST_PAGE_SIZE,
      offset: LIST_PAGE_SIZE,
    });
    const removed = removeMock.mock.calls.flatMap(([paths]) => paths as string[]);
    expect(removed).toHaveLength(files.length);
    expect(new Set(removed).size).toBe(files.length);
  });

  it("removes in batches no larger than the Storage API limit", async () => {
    const files = Array.from({ length: REMOVE_BATCH_SIZE * 2 + 1 }, (_, i) => file(`f-${i}`));
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: files });

    await removeAllUserAttachments(client, USER_ID);

    expect(removeMock.mock.calls.map(([paths]) => (paths as string[]).length)).toEqual([
      REMOVE_BATCH_SIZE,
      REMOVE_BATCH_SIZE,
      1,
    ]);
  });

  it("throws a list error without removing anything or reporting it", async () => {
    const listError = new Error("list failed");
    listMock.mockResolvedValue({ data: null, error: listError });

    await expect(removeAllUserAttachments(client, USER_ID)).rejects.toBe(listError);

    expect(removeMock).not.toHaveBeenCalled();
    // Reporting is the caller's job, so the error is not captured twice.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("throws a list error from a nested folder", async () => {
    const listError = new Error("nested list failed");
    listMock.mockImplementation((prefix: string) =>
      Promise.resolve(
        prefix === USER_ID
          ? { data: [folder("note-1")], error: null }
          : { data: null, error: listError },
      ),
    );

    await expect(removeAllUserAttachments(client, USER_ID)).rejects.toBe(listError);

    expect(removeMock).not.toHaveBeenCalled();
  });

  it("throws on the first failed remove batch and stops there", async () => {
    const files = Array.from({ length: REMOVE_BATCH_SIZE + 1 }, (_, i) => file(`f-${i}`));
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: files });
    const removeError = new Error("remove failed");
    removeMock.mockResolvedValueOnce({ data: null, error: removeError });

    await expect(removeAllUserAttachments(client, USER_ID)).rejects.toBe(removeError);

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("throws a thrown remove error", async () => {
    mockTree({ [USER_ID]: [folder("note-1")], [`${USER_ID}/note-1`]: [file("a.png")] });
    const thrown = new Error("socket hang up");
    removeMock.mockRejectedValue(thrown);

    await expect(removeAllUserAttachments(client, USER_ID)).rejects.toBe(thrown);
  });
});
