import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_USAGE_URL,
  STORAGE_USAGE_URL,
  fetchContentUsage,
  fetchStorageUsage,
  parseStorageUsage,
} from "@/lib/storage/fetch-storage-usage";

describe("parseStorageUsage", () => {
  it("reads a finite and an unlimited quota", () => {
    expect(parseStorageUsage({ usedBytes: 10, quotaBytes: 50 })).toEqual({
      usedBytes: 10,
      quotaBytes: 50,
    });
    expect(parseStorageUsage({ usedBytes: 0, quotaBytes: null })).toEqual({
      usedBytes: 0,
      quotaBytes: null,
    });
  });

  it("rejects bodies that aren't a usage reading", () => {
    expect(parseStorageUsage(null)).toBeNull();
    expect(parseStorageUsage("10")).toBeNull();
    expect(parseStorageUsage({ usedBytes: -1, quotaBytes: 50 })).toBeNull();
    expect(parseStorageUsage({ usedBytes: "10", quotaBytes: 50 })).toBeNull();
    expect(parseStorageUsage({ usedBytes: 10 })).toBeNull();
    expect(parseStorageUsage({ usedBytes: 10, quotaBytes: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe("fetchStorageUsage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the usage endpoint and parses its body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ usedBytes: 5, quotaBytes: 50 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchStorageUsage()).resolves.toEqual({ usedBytes: 5, quotaBytes: 50 });
    expect(fetchMock).toHaveBeenCalledWith(STORAGE_USAGE_URL);
  });

  it("returns null on an error status, a bad body or a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }),
    );
    await expect(fetchStorageUsage()).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new Error("not json")) }),
    );
    await expect(fetchStorageUsage()).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(fetchStorageUsage()).resolves.toBeNull();
  });
});

describe("fetchContentUsage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads GET /api/content-usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ usedBytes: 3, quotaBytes: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchContentUsage()).resolves.toEqual({ usedBytes: 3, quotaBytes: null });
    expect(fetchMock).toHaveBeenCalledWith(CONTENT_USAGE_URL);
  });

  it("returns null when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(fetchContentUsage()).resolves.toBeNull();
  });
});
