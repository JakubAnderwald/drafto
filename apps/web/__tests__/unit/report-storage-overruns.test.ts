import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

const { reportStorageOverruns } = await import("@/lib/storage/report-storage-overruns");

function clientWith(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as never;
}

describe("reportStorageOverruns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends one Sentry warning listing the users over their quota", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { user_id: "u-1", object_bytes: 200, quota_bytes: 100 },
        // Bigints can arrive as numeric strings.
        { user_id: "u-2", object_bytes: "300", quota_bytes: "100" },
      ],
      error: null,
    });

    await expect(reportStorageOverruns(clientWith(rpc))).resolves.toBe(2);
    expect(rpc).toHaveBeenCalledWith("storage_quota_overruns");
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      "2 user(s) store more attachment bytes than their quota allows",
      {
        level: "warning",
        extra: {
          overruns: [
            { userId: "u-1", objectBytes: 200, quotaBytes: 100 },
            { userId: "u-2", objectBytes: 300, quotaBytes: 100 },
          ],
        },
      },
    );
  });

  it("sends nothing when no one is over", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await expect(reportStorageOverruns(clientWith(rpc))).resolves.toBe(0);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("skips rows it can't read and a body that isn't a list", async () => {
    const rows = vi.fn().mockResolvedValue({ data: [null, { user_id: 1 }], error: null });
    await expect(reportStorageOverruns(clientWith(rows))).resolves.toBe(0);

    const notList = vi.fn().mockResolvedValue({ data: 5, error: null });
    await expect(reportStorageOverruns(clientWith(notList))).resolves.toBe(0);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("reports an RPC error to Sentry and counts none", async () => {
    const failure = { message: "permission denied" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: failure });

    await expect(reportStorageOverruns(clientWith(rpc))).resolves.toBe(0);
    expect(captureException).toHaveBeenCalledWith(failure, {
      extra: { where: "storage-overruns:rpc" },
    });
  });

  it("never throws when the RPC call itself throws", async () => {
    const failure = new Error("network");
    const rpc = vi.fn().mockRejectedValue(failure);

    await expect(reportStorageOverruns(clientWith(rpc))).resolves.toBe(0);
    expect(captureException).toHaveBeenCalledWith(failure, {
      extra: { where: "storage-overruns:rpc" },
    });
  });
});
