import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => mockCreateAdminClient(...args),
}));

const { removeOrphanedAttachments, removeUserOrphanedAttachments, MAX_ORPHAN_BATCHES } =
  await import("@/lib/storage/remove-orphaned-attachments");
const { REMOVE_BATCH_SIZE: ORPHAN_BATCH_SIZE } =
  await import("@/lib/storage/remove-user-attachments");

const USER_ID = "bbbbbbbb-0000-4000-8000-000000000002";

const rpcMock = vi.fn();
const removeMock = vi.fn();
const storageFromMock = vi.fn(() => ({ remove: removeMock }));
const client = {
  rpc: rpcMock,
  storage: { from: storageFromMock },
} as unknown as SupabaseClient<Database>;

const paths = (count: number, prefix = "p") =>
  Array.from({ length: count }, (_, i) => `${USER_ID}/note-${prefix}/${i}.png`);

/** Storage's remove() answers with the objects it deleted. */
const deletedAll = (names: string[]) => ({ data: names.map((name) => ({ name })), error: null });

beforeEach(() => {
  vi.clearAllMocks();
  removeMock.mockImplementation((names: string[]) => Promise.resolve(deletedAll(names)));
});

describe("removeOrphanedAttachments", () => {
  it("removes the listed orphans of one user and returns the count", async () => {
    const orphans = paths(3);
    rpcMock.mockResolvedValueOnce({ data: orphans, error: null });

    await expect(removeOrphanedAttachments(client, USER_ID)).resolves.toBe(3);

    expect(rpcMock).toHaveBeenCalledWith("orphaned_attachment_objects", {
      max_rows: ORPHAN_BATCH_SIZE,
      only_user: USER_ID,
    });
    expect(storageFromMock).toHaveBeenCalledWith("attachments");
    expect(removeMock).toHaveBeenCalledWith(orphans);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("lists every user's orphans when no user is given", async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });

    await expect(removeOrphanedAttachments(client)).resolves.toBe(0);

    expect(rpcMock).toHaveBeenCalledWith("orphaned_attachment_objects", {
      max_rows: ORPHAN_BATCH_SIZE,
      only_user: null,
    });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("keeps going while a batch comes back full", async () => {
    rpcMock
      .mockResolvedValueOnce({ data: paths(ORPHAN_BATCH_SIZE, "a"), error: null })
      .mockResolvedValueOnce({ data: paths(2, "b"), error: null });

    await expect(removeOrphanedAttachments(client)).resolves.toBe(ORPHAN_BATCH_SIZE + 2);
    expect(removeMock).toHaveBeenCalledTimes(2);
  });

  it("stops after MAX_ORPHAN_BATCHES full batches", async () => {
    rpcMock.mockResolvedValue({ data: paths(ORPHAN_BATCH_SIZE), error: null });

    await expect(removeOrphanedAttachments(client)).resolves.toBe(
      ORPHAN_BATCH_SIZE * MAX_ORPHAN_BATCHES,
    );
    expect(rpcMock).toHaveBeenCalledTimes(MAX_ORPHAN_BATCHES);
  });

  it("reports a listing error to Sentry without throwing or removing anything", async () => {
    const listError = { message: "permission denied for function orphaned_attachment_objects" };
    rpcMock.mockResolvedValueOnce({ data: null, error: listError });

    await expect(removeOrphanedAttachments(client, USER_ID)).resolves.toBe(0);

    expect(removeMock).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(listError, {
      extra: { where: "remove-orphaned-attachments", userId: USER_ID, removed: 0 },
    });
  });

  it("reports a remove error to Sentry and stops, keeping what was removed", async () => {
    const removeError = { message: "storage unavailable" };
    rpcMock
      .mockResolvedValueOnce({ data: paths(ORPHAN_BATCH_SIZE, "a"), error: null })
      .mockResolvedValueOnce({ data: paths(5, "b"), error: null });
    removeMock
      .mockImplementationOnce((names: string[]) => Promise.resolve(deletedAll(names)))
      .mockResolvedValueOnce({ data: null, error: removeError });

    await expect(removeOrphanedAttachments(client)).resolves.toBe(ORPHAN_BATCH_SIZE);

    expect(mockCaptureException).toHaveBeenCalledWith(removeError, {
      extra: { where: "remove-orphaned-attachments", userId: "all", removed: ORPHAN_BATCH_SIZE },
    });
  });

  it("counts what Storage actually deleted", async () => {
    rpcMock.mockResolvedValueOnce({ data: paths(3), error: null });
    removeMock.mockResolvedValueOnce({ data: [{ name: "one" }, { name: "two" }], error: null });

    await expect(removeOrphanedAttachments(client, USER_ID)).resolves.toBe(2);
  });

  it("stops, and reports to Sentry, when a remove deletes nothing", async () => {
    // Otherwise every round would list the same names again.
    rpcMock.mockResolvedValue({ data: paths(ORPHAN_BATCH_SIZE), error: null });
    removeMock.mockResolvedValue({ data: [], error: null });

    await expect(removeOrphanedAttachments(client)).resolves.toBe(0);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("removed none") }),
      expect.anything(),
    );
  });

  it("reports a thrown error to Sentry without throwing", async () => {
    const thrown = new Error("network down");
    rpcMock.mockRejectedValueOnce(thrown);

    await expect(removeOrphanedAttachments(client)).resolves.toBe(0);
    expect(mockCaptureException).toHaveBeenCalledWith(thrown, expect.anything());
  });
});

describe("removeUserOrphanedAttachments", () => {
  it("sweeps the user's orphans with a service-role client carrying the tag", async () => {
    mockCreateAdminClient.mockReturnValue(client);
    rpcMock.mockResolvedValueOnce({ data: paths(1), error: null });

    await removeUserOrphanedAttachments(USER_ID, "web-trash");

    expect(mockCreateAdminClient).toHaveBeenCalledWith("web-trash");
    expect(rpcMock).toHaveBeenCalledWith("orphaned_attachment_objects", {
      max_rows: ORPHAN_BATCH_SIZE,
      only_user: USER_ID,
    });
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it("reports a missing service-role key to Sentry without throwing", async () => {
    const missingKey = new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
    mockCreateAdminClient.mockImplementation(() => {
      throw missingKey;
    });

    await expect(removeUserOrphanedAttachments(USER_ID, "web-trash")).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledWith(missingKey, {
      extra: {
        where: "remove-user-orphaned-attachments",
        userId: USER_ID,
        clientTag: "web-trash",
      },
    });
  });
});
