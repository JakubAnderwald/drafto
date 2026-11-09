import { describe, expect, it } from "vitest";

import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_FILE_SIZE,
  STORAGE_QUOTA_EXCEEDED_CODE,
  STORAGE_QUOTA_EXCEEDED_MESSAGE,
  STORAGE_WARNING_RATIO,
} from "../src/constants";
import {
  BYTES_PER_MEGABYTE,
  StorageQuotaError,
  bytesToMegabytes,
  formatMegabytes,
  formatStorageUsage,
  isStorageQuotaError,
  megabytesToBytes,
  storageFullMessage,
  storageQuotaErrorFromResponse,
  storageUsageFromRow,
  storageUsageRatio,
  storageUsageTone,
  wouldExceedQuota,
} from "../src/storage/storage-quota";

const MB = BYTES_PER_MEGABYTE;

describe("storage quota constants", () => {
  it("defaults to 50 MB, matching the migration's column default", () => {
    expect(DEFAULT_STORAGE_QUOTA_BYTES).toBe(52428800);
    expect(DEFAULT_STORAGE_QUOTA_BYTES).toBe(50 * MB);
  });

  it("keeps the trigger's error text and the warning threshold", () => {
    expect(STORAGE_QUOTA_EXCEEDED_CODE).toBe("storage_quota_exceeded");
    expect(STORAGE_QUOTA_EXCEEDED_MESSAGE).toBe("Storage quota exceeded");
    expect(STORAGE_WARNING_RATIO).toBe(0.9);
  });

  it("uses the same one-file slack as the per-file limit", () => {
    // can_store_attachment() allows objects up to quota + 52428800 (one max file).
    expect(MAX_FILE_SIZE).toBe(52428800);
  });
});

describe("bytesToMegabytes / megabytesToBytes", () => {
  it("converts both ways in binary megabytes", () => {
    expect(bytesToMegabytes(50 * MB)).toBe(50);
    expect(megabytesToBytes(50)).toBe(52428800);
    expect(megabytesToBytes(0.5)).toBe(524288);
  });

  it("rounds fractional bytes", () => {
    expect(megabytesToBytes(1.0000001)).toBe(Math.round(1.0000001 * MB));
    expect(Number.isInteger(megabytesToBytes(12.34))).toBe(true);
  });
});

describe("formatMegabytes", () => {
  it("shows whole megabytes without a decimal", () => {
    expect(formatMegabytes(50 * MB)).toBe("50 MB");
    expect(formatMegabytes(1024 * MB)).toBe("1024 MB");
  });

  it("rounds to one decimal", () => {
    expect(formatMegabytes(12.4 * MB)).toBe("12.4 MB");
    expect(formatMegabytes(12.44 * MB)).toBe("12.4 MB");
    expect(formatMegabytes(12.46 * MB)).toBe("12.5 MB");
    expect(formatMegabytes(49.96 * MB)).toBe("50 MB");
  });

  it("never shows a small non-zero amount as nothing", () => {
    expect(formatMegabytes(1)).toBe("< 0.1 MB");
    expect(formatMegabytes(0.04 * MB)).toBe("< 0.1 MB");
    expect(formatMegabytes(0.05 * MB)).toBe("0.1 MB");
  });

  it("shows zero, negative and non-finite input as 0 MB", () => {
    expect(formatMegabytes(0)).toBe("0 MB");
    expect(formatMegabytes(-5)).toBe("0 MB");
    expect(formatMegabytes(Number.NaN)).toBe("0 MB");
    expect(formatMegabytes(Number.POSITIVE_INFINITY)).toBe("0 MB");
  });
});

describe("formatStorageUsage", () => {
  it("shows used of quota", () => {
    expect(formatStorageUsage(12.4 * MB, 50 * MB)).toBe("Storage: 12.4 MB of 50 MB used");
    expect(formatStorageUsage(0, 50 * MB)).toBe("Storage: 0 MB of 50 MB used");
  });

  it("shows only what is used when unlimited", () => {
    expect(formatStorageUsage(496 * MB, null)).toBe("Storage: 496 MB used");
  });
});

describe("storageFullMessage", () => {
  it("names the usage and the quota", () => {
    expect(storageFullMessage(49.5 * MB, 50 * MB)).toBe(
      "Storage full: you've used 49.5 MB of your 50 MB. Delete notes with attachments and empty the trash to free space.",
    );
  });

  it("still explains the refusal when the numbers are unknown", () => {
    const expected =
      "Storage full: you've used all of your storage. Delete notes with attachments and empty the trash to free space.";
    expect(storageFullMessage(undefined, undefined)).toBe(expected);
    expect(storageFullMessage(10 * MB, null)).toBe(expected);
    expect(storageFullMessage(null, 50 * MB)).toBe(expected);
  });
});

describe("StorageQuotaError", () => {
  it("carries the usage and the storage-full message", () => {
    const usage = { usedBytes: 48 * MB, quotaBytes: 50 * MB };
    const err = new StorageQuotaError(usage);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StorageQuotaError");
    expect(err.usage).toEqual(usage);
    expect(err.message).toBe(storageFullMessage(48 * MB, 50 * MB));
  });

  it("works without known usage", () => {
    const err = new StorageQuotaError();
    expect(err.usage).toBeNull();
    expect(err.message).toBe(storageFullMessage(undefined, undefined));
  });
});

describe("isStorageQuotaError", () => {
  it("recognises a StorageQuotaError", () => {
    expect(isStorageQuotaError(new StorageQuotaError())).toBe(true);
  });

  it("recognises the trigger's PostgrestError", () => {
    expect(
      isStorageQuotaError({
        message: "storage_quota_exceeded",
        code: "P0001",
        details: "used_bytes=1 quota_bytes=2 file_size=5",
        hint: "Delete notes with attachments and empty the trash to free space.",
      }),
    ).toBe(true);
  });

  it("recognises an Error wrapping the trigger's message", () => {
    expect(
      isStorageQuotaError(new Error("Failed to save attachment record: storage_quota_exceeded")),
    ).toBe(true);
  });

  it("recognises the web API's 413 body by its code", () => {
    expect(
      isStorageQuotaError({
        error: "Storage quota exceeded",
        code: "storage_quota_exceeded",
        usedBytes: 1,
        quotaBytes: 2,
      }),
    ).toBe(true);
  });

  it("recognises a plain string and a serialised StorageQuotaError", () => {
    expect(isStorageQuotaError("storage_quota_exceeded")).toBe(true);
    expect(isStorageQuotaError({ name: "StorageQuotaError", message: "x" })).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isStorageQuotaError(null)).toBe(false);
    expect(isStorageQuotaError(undefined)).toBe(false);
    expect(isStorageQuotaError(413)).toBe(false);
    expect(isStorageQuotaError("File size exceeds 50MB limit")).toBe(false);
    expect(isStorageQuotaError(new Error("new row violates row-level security policy"))).toBe(
      false,
    );
    expect(isStorageQuotaError({ error: "File size exceeds 50MB limit", status: 413 })).toBe(false);
    expect(isStorageQuotaError({ message: 42 })).toBe(false);
  });
});

describe("storageQuotaErrorFromResponse", () => {
  const quotaBody = {
    error: STORAGE_QUOTA_EXCEEDED_MESSAGE,
    code: STORAGE_QUOTA_EXCEEDED_CODE,
    usedBytes: 48 * MB,
    quotaBytes: 50 * MB,
  };

  it("turns the quota 413 into a StorageQuotaError carrying the usage", () => {
    const err = storageQuotaErrorFromResponse(413, quotaBody);
    expect(err).toBeInstanceOf(StorageQuotaError);
    expect(err?.usage).toEqual({ usedBytes: 48 * MB, quotaBytes: 50 * MB });
    expect(err?.message).toBe(storageFullMessage(48 * MB, 50 * MB));
  });

  it("drops usage numbers it can't trust", () => {
    const err = storageQuotaErrorFromResponse(413, { ...quotaBody, usedBytes: "48" });
    expect(err).toBeInstanceOf(StorageQuotaError);
    expect(err?.usage).toBeNull();
    expect(storageQuotaErrorFromResponse(413, { code: STORAGE_QUOTA_EXCEEDED_CODE })?.usage).toBe(
      null,
    );
  });

  it("ignores the per-file size 413, other statuses and missing bodies", () => {
    expect(
      storageQuotaErrorFromResponse(413, { error: "File size exceeds 50MB limit", status: 413 }),
    ).toBeNull();
    expect(storageQuotaErrorFromResponse(500, quotaBody)).toBeNull();
    expect(storageQuotaErrorFromResponse(413, null)).toBeNull();
  });
});

describe("wouldExceedQuota", () => {
  const quota = 50 * MB;

  it("allows an upload under the quota", () => {
    expect(wouldExceedQuota({ usedBytes: 10 * MB, quotaBytes: quota }, 5 * MB)).toBe(false);
  });

  it("allows an upload that lands exactly on the quota", () => {
    expect(wouldExceedQuota({ usedBytes: 45 * MB, quotaBytes: quota }, 5 * MB)).toBe(false);
  });

  it("refuses an upload that goes over the quota", () => {
    expect(wouldExceedQuota({ usedBytes: 45 * MB, quotaBytes: quota }, 5 * MB + 1)).toBe(true);
    expect(wouldExceedQuota({ usedBytes: quota, quotaBytes: quota }, 1)).toBe(true);
  });

  it("never refuses an unlimited user", () => {
    expect(wouldExceedQuota({ usedBytes: 10_000 * MB, quotaBytes: null }, 50 * MB)).toBe(false);
  });
});

describe("storageUsageRatio", () => {
  it("is used / quota", () => {
    expect(storageUsageRatio({ usedBytes: 25 * MB, quotaBytes: 50 * MB })).toBe(0.5);
  });

  it("is null when unlimited and 1 for a zero quota", () => {
    expect(storageUsageRatio({ usedBytes: 25 * MB, quotaBytes: null })).toBeNull();
    expect(storageUsageRatio({ usedBytes: 0, quotaBytes: 0 })).toBe(1);
  });
});

describe("storageUsageTone", () => {
  const quota = 100 * MB;

  it("is default up to and including 90%", () => {
    expect(storageUsageTone({ usedBytes: 0, quotaBytes: quota })).toBe("default");
    expect(storageUsageTone({ usedBytes: 90 * MB, quotaBytes: quota })).toBe("default");
  });

  it("is warning above 90%", () => {
    expect(storageUsageTone({ usedBytes: 90 * MB + 1, quotaBytes: quota })).toBe("warning");
    expect(storageUsageTone({ usedBytes: quota - 1, quotaBytes: quota })).toBe("warning");
  });

  it("is danger at or over 100%", () => {
    expect(storageUsageTone({ usedBytes: quota, quotaBytes: quota })).toBe("danger");
    expect(storageUsageTone({ usedBytes: quota * 2, quotaBytes: quota })).toBe("danger");
  });

  it("is default when unlimited", () => {
    expect(storageUsageTone({ usedBytes: 10_000 * MB, quotaBytes: null })).toBe("default");
  });
});

describe("storageUsageFromRow", () => {
  it("maps an RPC row", () => {
    expect(storageUsageFromRow({ used_bytes: 1234, quota_bytes: 52428800 })).toEqual({
      usedBytes: 1234,
      quotaBytes: 52428800,
    });
  });

  it("maps unlimited", () => {
    expect(storageUsageFromRow({ used_bytes: 5, quota_bytes: null })).toEqual({
      usedBytes: 5,
      quotaBytes: null,
    });
    expect(storageUsageFromRow({ used_bytes: 5 })).toEqual({ usedBytes: 5, quotaBytes: null });
  });

  it("takes the first row of an array and accepts numeric strings", () => {
    expect(storageUsageFromRow([{ used_bytes: "10", quota_bytes: "20" }])).toEqual({
      usedBytes: 10,
      quotaBytes: 20,
    });
  });

  it("returns null for anything else", () => {
    expect(storageUsageFromRow(null)).toBeNull();
    expect(storageUsageFromRow([])).toBeNull();
    expect(storageUsageFromRow("x")).toBeNull();
    expect(storageUsageFromRow({ used_bytes: -1, quota_bytes: 5 })).toBeNull();
    expect(storageUsageFromRow({ used_bytes: "abc", quota_bytes: 5 })).toBeNull();
    expect(storageUsageFromRow({ used_bytes: 1, quota_bytes: "x" })).toBeNull();
  });
});
