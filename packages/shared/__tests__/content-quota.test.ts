import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONTENT_QUOTA_EXCEEDED_CODE,
  CONTENT_QUOTA_EXCEEDED_MESSAGE,
  DEFAULT_CONTENT_QUOTA_BYTES,
  STORAGE_QUOTA_EXCEEDED_CODE,
} from "../src/constants";
import {
  ContentQuotaError,
  contentFullMessage,
  contentQuotaErrorFromResponse,
  contentUsageFromError,
  formatContentUsage,
  isContentQuotaError,
} from "../src/storage/content-quota";
import { BYTES_PER_MEGABYTE, isStorageQuotaError } from "../src/storage/storage-quota";

const MB = BYTES_PER_MEGABYTE;

describe("content quota constants", () => {
  it("default is 25 MB and matches the migration's column default", () => {
    expect(DEFAULT_CONTENT_QUOTA_BYTES).toBe(25 * MB);
    const sql = readFileSync(
      resolve(__dirname, "../../../supabase/migrations/20261121000001_per_user_content_quota.sql"),
      "utf8",
    );
    expect(sql).toContain(`content_quota_bytes bigint default ${DEFAULT_CONTENT_QUOTA_BYTES}`);
    expect(sql).toContain(`message = '${CONTENT_QUOTA_EXCEEDED_CODE}'`);
  });

  it("code differs from the storage quota's, so neither matches the other", () => {
    expect(CONTENT_QUOTA_EXCEEDED_CODE).not.toBe(STORAGE_QUOTA_EXCEEDED_CODE);
    expect(isStorageQuotaError({ message: CONTENT_QUOTA_EXCEEDED_CODE })).toBe(false);
    expect(isContentQuotaError({ message: STORAGE_QUOTA_EXCEEDED_CODE })).toBe(false);
  });
});

describe("formatContentUsage", () => {
  it("shows used of quota", () => {
    expect(formatContentUsage(1.2 * MB, 25 * MB)).toBe("Notes: 1.2 MB of 25 MB used");
  });

  it("shows only used when unlimited", () => {
    expect(formatContentUsage(3 * MB, null)).toBe("Notes: 3 MB used");
  });
});

describe("contentFullMessage", () => {
  it("includes the numbers when known", () => {
    expect(contentFullMessage(25 * MB, 25 * MB)).toBe(
      "Notes full: you've used 25 MB of your 25 MB for notes. Delete notes you no longer need and empty the trash to free space.",
    );
  });

  it("still explains without numbers", () => {
    expect(contentFullMessage(null, undefined)).toMatch(/^Notes full: you've used all/);
  });
});

describe("isContentQuotaError", () => {
  it("recognises a ContentQuotaError", () => {
    expect(isContentQuotaError(new ContentQuotaError())).toBe(true);
  });

  it("recognises the trigger's PostgrestError", () => {
    expect(
      isContentQuotaError({ code: "P0001", message: CONTENT_QUOTA_EXCEEDED_CODE, details: "" }),
    ).toBe(true);
  });

  it("recognises the web API 413 body", () => {
    expect(
      isContentQuotaError({
        error: CONTENT_QUOTA_EXCEEDED_MESSAGE,
        code: CONTENT_QUOTA_EXCEEDED_CODE,
      }),
    ).toBe(true);
  });

  it("recognises a string and an Error wrapping the message", () => {
    expect(isContentQuotaError(`push failed: ${CONTENT_QUOTA_EXCEEDED_CODE}`)).toBe(true);
    expect(isContentQuotaError(new Error(CONTENT_QUOTA_EXCEEDED_CODE))).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isContentQuotaError(null)).toBe(false);
    expect(isContentQuotaError(undefined)).toBe(false);
    expect(isContentQuotaError(42)).toBe(false);
    expect(isContentQuotaError({ message: "network error" })).toBe(false);
  });
});

describe("contentUsageFromError", () => {
  it("parses the trigger's detail", () => {
    expect(
      contentUsageFromError({
        message: CONTENT_QUOTA_EXCEEDED_CODE,
        details: "used_bytes=1000 quota_bytes=2000 note_bytes=1500",
      }),
    ).toEqual({ usedBytes: 1000, quotaBytes: 2000 });
  });

  it("reads a 413 body", () => {
    expect(contentUsageFromError({ usedBytes: 5, quotaBytes: 10 })).toEqual({
      usedBytes: 5,
      quotaBytes: 10,
    });
  });

  it("returns null without both numbers", () => {
    expect(contentUsageFromError({ details: "used_bytes=1" })).toBeNull();
    expect(contentUsageFromError("x")).toBeNull();
    expect(contentUsageFromError(null)).toBeNull();
  });
});

describe("contentQuotaErrorFromResponse", () => {
  it("builds an error with the usage from a quota 413", () => {
    const err = contentQuotaErrorFromResponse(413, {
      code: CONTENT_QUOTA_EXCEEDED_CODE,
      usedBytes: 25 * MB,
      quotaBytes: 25 * MB,
    });
    expect(err).toBeInstanceOf(ContentQuotaError);
    expect(err?.usage).toEqual({ usedBytes: 25 * MB, quotaBytes: 25 * MB });
  });

  it("returns null for other statuses and other 413s", () => {
    expect(contentQuotaErrorFromResponse(500, { code: CONTENT_QUOTA_EXCEEDED_CODE })).toBeNull();
    expect(contentQuotaErrorFromResponse(413, { error: "File too large" })).toBeNull();
  });
});
