const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
const mockUnsafeReset = jest.fn();
const mockWrite = jest.fn((work: () => unknown) => Promise.resolve(work()));
const mockFetchCount = jest.fn();
const mockDeleteAllLocalAttachments = jest.fn();

jest.mock("expo-secure-store", () => ({
  getItemAsync: (...args: unknown[]) => mockGetItem(...args),
  setItemAsync: (...args: unknown[]) => mockSetItem(...args),
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

    await ensureLocalIdentity("user-1");

    expect(mockUnsafeReset).not.toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it("persists the new id but does not reset when a different user signs in on an empty DB", async () => {
    mockGetItem.mockResolvedValue("user-1");
    mockFetchCount.mockResolvedValue(0);

    await ensureLocalIdentity("user-2");

    expect(mockUnsafeReset).not.toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).not.toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith(KEY, "user-2");
  });

  it("resets the DB, wipes attachments, and persists the id when a different user signs in on a non-empty DB", async () => {
    mockGetItem.mockResolvedValue("user-1");
    // First table (notebooks) is non-empty → short-circuits to true.
    mockFetchCount.mockResolvedValueOnce(3);

    await ensureLocalIdentity("user-2");

    expect(mockUnsafeReset).toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith(KEY, "user-2");
  });

  it("does not reset on the first sign-in (no stored id), even with local data", async () => {
    mockGetItem.mockResolvedValue(null);
    mockFetchCount.mockResolvedValue(5);

    await ensureLocalIdentity("user-1");

    expect(mockUnsafeReset).not.toHaveBeenCalled();
    expect(mockDeleteAllLocalAttachments).not.toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith(KEY, "user-1");
  });

  it("tolerates a storage read failure without resetting or throwing", async () => {
    mockGetItem.mockRejectedValue(new Error("keychain locked"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureLocalIdentity("user-1")).resolves.toBeUndefined();

    expect(mockUnsafeReset).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("still persists the new id when the reset fails", async () => {
    mockGetItem.mockResolvedValue("user-1");
    mockFetchCount.mockResolvedValueOnce(2);
    mockUnsafeReset.mockRejectedValueOnce(new Error("reset boom"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(ensureLocalIdentity("user-2")).resolves.toBeUndefined();

    expect(mockSetItem).toHaveBeenCalledWith(KEY, "user-2");
    errorSpy.mockRestore();
  });

  it("tolerates a persist failure without throwing", async () => {
    mockGetItem.mockResolvedValue("user-1");
    mockFetchCount.mockResolvedValue(0);
    mockSetItem.mockRejectedValue(new Error("write failed"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureLocalIdentity("user-2")).resolves.toBeUndefined();

    warnSpy.mockRestore();
  });
});
