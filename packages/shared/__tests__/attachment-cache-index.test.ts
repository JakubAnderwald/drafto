import { describe, expect, it } from "vitest";

import {
  AttachmentCacheIndex,
  parseAttachmentCacheIndex,
} from "../src/storage/attachment-cache-index";

const file = (relativePath: string, size: number, modifiedAt = 1) => ({
  relativePath,
  size,
  modifiedAt,
});

describe("AttachmentCacheIndex", () => {
  it("is filled by one walk, with the saved last use winning over the file time", () => {
    const index = new AttachmentCacheIndex();
    expect(index.isLoaded).toBe(false);
    index.load([file("a", 10, 100), file("b", 20, 200)], new Map([["a", 500]]));
    expect(index.isLoaded).toBe(true);
    expect(index.totalBytes).toBe(30);
    expect(index.entries()).toEqual([
      { relativePath: "a", size: 10, lastUsedAt: 500 },
      { relativePath: "b", size: 20, lastUsedAt: 200 },
    ]);
  });

  it("keeps the running total as files are written, replaced and deleted", () => {
    const index = new AttachmentCacheIndex();
    index.load([], new Map());
    index.record("a", 10, 1);
    index.record("b", 5, 2);
    index.record("a", 7, 3);
    expect(index.totalBytes).toBe(12);
    index.remove("b");
    index.remove("missing");
    expect(index.totalBytes).toBe(7);
    expect(index.has("a")).toBe(true);
    expect(index.has("b")).toBe(false);
  });

  it("records a new file as used now, whatever its file time", () => {
    const index = new AttachmentCacheIndex();
    index.load([file("old-photo", 10, 1)], new Map());
    index.record("old-photo", 10, 9_000);
    expect(index.entries()[0].lastUsedAt).toBe(9_000);
  });

  it("touches only files it has", () => {
    const index = new AttachmentCacheIndex();
    index.load([file("a", 1)], new Map());
    expect(index.touch("a", 42)).toBe(true);
    expect(index.touch("b", 42)).toBe(false);
    expect(index.entries()).toEqual([{ relativePath: "a", size: 1, lastUsedAt: 42 }]);
  });

  it("survives a round trip through its file", () => {
    const index = new AttachmentCacheIndex();
    index.load([], new Map());
    index.record("u/n/a.jpg", 10, 123);
    const restored = parseAttachmentCacheIndex(index.serialize());
    expect(restored).toEqual(new Map([["u/n/a.jpg", 123]]));
  });

  it("is emptied by clear", () => {
    const index = new AttachmentCacheIndex();
    index.load([file("a", 1)], new Map());
    index.clear();
    expect(index.isLoaded).toBe(false);
    expect(index.totalBytes).toBe(0);
    expect(index.entries()).toEqual([]);
  });
});

describe("parseAttachmentCacheIndex", () => {
  it.each([null, undefined, "", "not json", "null", "[]", '{"v":2,"lastUsed":{}}'])(
    "reads %p as empty",
    (json) => {
      expect(parseAttachmentCacheIndex(json)).toEqual(new Map());
    },
  );

  it("skips entries that aren't times", () => {
    expect(parseAttachmentCacheIndex('{"v":1,"lastUsed":{"a":1,"b":"x","c":null}}')).toEqual(
      new Map([["a", 1]]),
    );
  });
});
