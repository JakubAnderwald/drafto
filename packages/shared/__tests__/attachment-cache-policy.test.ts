import { describe, expect, it } from "vitest";

import {
  isCacheableAttachment,
  planAttachmentCacheEviction,
  selectPrefetchCandidates,
  type AttachmentCacheEntry,
  type PrefetchLimits,
} from "../src/storage/attachment-cache-policy";

const entry = (relativePath: string, size: number, lastUsedAt: number): AttachmentCacheEntry => ({
  relativePath,
  size,
  lastUsedAt,
});

describe("planAttachmentCacheEviction", () => {
  it("evicts nothing while the cache fits", () => {
    expect(
      planAttachmentCacheEviction([entry("a", 50, 1), entry("b", 50, 2)], 100, new Set()),
    ).toEqual([]);
  });

  it("evicts the least recently used files first, until the cache fits", () => {
    const entries = [entry("new", 40, 30), entry("old", 40, 10), entry("mid", 40, 20)];
    expect(planAttachmentCacheEviction(entries, 50, new Set())).toEqual(["old", "mid"]);
  });

  it("never evicts a protected file (pending, failed or quota_exceeded)", () => {
    const entries = [entry("pending", 60, 1), entry("quota", 60, 2), entry("viewed", 60, 3)];
    expect(planAttachmentCacheEviction(entries, 100, new Set(["pending", "quota"]))).toEqual([
      "viewed",
    ]);
  });

  it("leaves protected files even when they alone are over the cap", () => {
    const entries = [entry("pending", 500, 1)];
    expect(planAttachmentCacheEviction(entries, 100, new Set(["pending"]))).toEqual([]);
  });
});

describe("selectPrefetchCandidates", () => {
  const limits: PrefetchLimits = {
    maxFiles: 2,
    maxBytes: 100,
    maxFileBytes: 60,
    availableBytes: 1000,
  };
  const none = () => false;

  it("takes uncached files in order, up to the file limit", () => {
    const rows = [
      { filePath: "a", fileSize: 10 },
      { filePath: "b", fileSize: 10 },
      { filePath: "c", fileSize: 10 },
    ];
    expect(selectPrefetchCandidates(rows, none, limits).map((r) => r.filePath)).toEqual(["a", "b"]);
  });

  it("skips cached files, duplicates and files over the per-file limit", () => {
    const rows = [
      { filePath: "cached", fileSize: 10 },
      { filePath: "huge", fileSize: 61 },
      { filePath: "a", fileSize: 10 },
      { filePath: "a", fileSize: 10 },
    ];
    const isCached = (filePath: string) => filePath === "cached";
    expect(
      selectPrefetchCandidates(rows, isCached, { ...limits, maxFiles: 5 }).map((r) => r.filePath),
    ).toEqual(["a"]);
  });

  it("skips a file that would go over the byte budget but keeps looking", () => {
    const rows = [
      { filePath: "a", fileSize: 60 },
      { filePath: "b", fileSize: 50 },
      { filePath: "c", fileSize: 40 },
    ];
    expect(
      selectPrefetchCandidates(rows, none, { ...limits, maxFiles: 5 }).map((r) => r.filePath),
    ).toEqual(["a", "c"]);
  });

  it("never fills the cache past its cap", () => {
    const rows = [
      { filePath: "a", fileSize: 30 },
      { filePath: "b", fileSize: 30 },
    ];
    expect(
      selectPrefetchCandidates(rows, none, { ...limits, availableBytes: 40 }).map(
        (r) => r.filePath,
      ),
    ).toEqual(["a"]);
    expect(selectPrefetchCandidates(rows, none, { ...limits, availableBytes: -5 })).toEqual([]);
  });
});

describe("isCacheableAttachment", () => {
  it.each([
    ["image/jpeg", true],
    ["IMAGE/PNG", true],
    ["application/pdf", false],
    ["video/mp4", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("%p → %p", (mimeType, expected) => {
    expect(isCacheableAttachment(mimeType)).toBe(expected);
  });
});
