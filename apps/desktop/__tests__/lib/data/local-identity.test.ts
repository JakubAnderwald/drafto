const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
const mockUnsafeReset = jest.fn();
const mockWrite = jest.fn((work: () => unknown) => Promise.resolve(work()));
const mockFetchCount = jest.fn();
const mockDeleteAllLocalAttachments = jest.fn();

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  setItem: (...args: unknown[]) => mockSetItem(...args),
}));

jest.mock("@/db", () => ({
  database: {
    write: (work: () => unknown) => mockWrite(work),
    unsafeResetDatabase: (...args: unknown[]) => mockUnsafeReset(...args),
    get: () => ({ query: () => ({ fetchCount: () => mockFetchCount() }) }),
  },
}));

jest.mock("@/lib/data/attachment-queue", () => ({
  deleteAllLocalAttachments: (...args: unknown[]) => mockDeleteAllLocalAttachments(...args),
}));

import { ensureLocalIdentity } from "@/lib/data/local-identity";

const KEY = "drafto_last_user_id";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetItem.mockResolvedValue(null);
  mockSetItem.mockResolvedValue(undefined);
  mockUnsafeReset.mockResolvedValue(undefined);
  mockWrite.mockImplementation((work: () => unknown) => Promise.resolve(work()));
  mockFetchCount.mockResolvedValue(0);
  mockDeleteAllLocalAttachments.mockResolvedValue(undefined);
});

describe("ensureLocalIdentity", () => {
  it("no-ops when the same user signs in again", async () => {
    mockGetItem.mockResolvedValue("user-1");

    await expect(ensureLocalIdentity("user-1")).resolves.toBe("ready");

    expect(mockUnsafeReset).not.toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it("cleans attachments (but does not reset the DB) when a different user signs in on an empty DB", async () => {
    mockGetItem.mockResolvedValue("user-1");
    mockFetchCount.mockResolvedValue(0);

    await expect(ensureLocalIdentity("user-2")).resolves.toBe("ready");

    // Empty DB → no reset needed, but attachment files can survive a prior
    // sign-out's failed deletion independently of the DB, so they are always
    // cleaned on a different-user sign-in (cross-account leak guard).
    expect(mockUnsafeReset).not.toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith(KEY, "user-2");
  });

  it("resets the DB, wipes attachments, and persists the id when a different user signs in on a non-empty DB", async () => {
    mockGetItem.mockResolvedValue("user-1");
    // First table (notebooks) is non-empty → short-circuits to true.
    mockFetchCount.mockResolvedValueOnce(3);

    await expect(ensureLocalIdentity("user-2")).resolves.toBe("ready");

    expect(mockUnsafeReset).toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith(KEY, "user-2");
  });

  it("does not reset on the first sign-in (no stored id), even with local data", async () => {
    mockGetItem.mockResolvedValue(null);
    mockFetchCount.mockResolvedValue(5);

    await expect(ensureLocalIdentity("user-1")).resolves.toBe("ready");

    expect(mockUnsafeReset).not.toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).not.toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith(KEY, "user-1");
  });

  it("tolerates a storage read failure without resetting or throwing", async () => {
    mockGetItem.mockRejectedValue(new Error("storage down"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureLocalIdentity("user-1")).resolves.toBe("ready");

    expect(mockUnsafeReset).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("reports unsafe and keeps the previous id when the reset fails", async () => {
    mockGetItem.mockResolvedValue("user-1");
    mockFetchCount.mockResolvedValueOnce(2);
    mockUnsafeReset.mockRejectedValueOnce(new Error("reset boom"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(ensureLocalIdentity("user-2")).resolves.toBe("unsafe");

    // Persisting the new id here would make the next launch take the same-user
    // early return and permanently disarm the guard while user-1's rows are
    // still on disk, so the previous id must survive for the retry.
    expect(mockSetItem).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("reports unsafe and keeps the previous id when the attachment wipe fails", async () => {
    mockGetItem.mockResolvedValue("user-1");
    mockFetchCount.mockResolvedValueOnce(2);
    mockDeleteAllLocalAttachments.mockRejectedValueOnce(new Error("unlink boom"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(ensureLocalIdentity("user-2")).resolves.toBe("unsafe");

    expect(mockSetItem).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs (at error level) but does not throw when persisting the id fails", async () => {
    mockGetItem.mockResolvedValue("user-1");
    mockFetchCount.mockResolvedValue(0);
    mockSetItem.mockRejectedValue(new Error("write failed"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(ensureLocalIdentity("user-2")).resolves.toBe("ready");

    // Observable, not swallowed: a stale stored id re-triggers a destructive
    // reset on this same user's next launch.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
