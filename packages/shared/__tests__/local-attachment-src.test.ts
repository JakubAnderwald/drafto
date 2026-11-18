import { describe, expect, it } from "vitest";

import {
  attachmentCacheRelativePath,
  extractFilePathFromLocalSrc,
  isLocalAttachmentSrc,
  toLocalAttachmentSrc,
} from "../src/editor/attachment-url";
import { LOCAL_ATTACHMENT_FRAGMENT } from "../src/constants";

const FILE_URI = "file:///data/user/0/eu.drafto.mobile/files/attachment-cache/u/n/photo.jpg";

describe("toLocalAttachmentSrc / extractFilePathFromLocalSrc", () => {
  it("appends the marker and the encoded storage path to the file URI", () => {
    expect(toLocalAttachmentSrc(FILE_URI, "u/n/my photo.jpg")).toBe(
      `${FILE_URI}${LOCAL_ATTACHMENT_FRAGMENT}u%2Fn%2Fmy%20photo.jpg`,
    );
  });

  it("drops a fragment the file URI already has", () => {
    expect(toLocalAttachmentSrc(`${FILE_URI}#old`, "u/n/a.jpg")).toBe(
      `${FILE_URI}${LOCAL_ATTACHMENT_FRAGMENT}u%2Fn%2Fa.jpg`,
    );
  });

  it.each([
    "user-1/note-1/plain.jpg",
    "user-1/note-1/a b & c + d's (1) $x @y=z;,.png",
    "user-1/note-1/zażółć gęślą jaźń 日本.jpg",
    "user-1/note-1/legacy#hash%25percent?.jpg",
    "user-1/note-1/" + "x".repeat(250) + ".jpg",
  ])("round-trips %s", (filePath) => {
    const src = toLocalAttachmentSrc(FILE_URI, filePath);
    expect(isLocalAttachmentSrc(src)).toBe(true);
    expect(extractFilePathFromLocalSrc(src)).toBe(filePath);
  });

  it.each([
    ["a plain file URL", FILE_URI],
    [
      "an https URL with the marker",
      `https://example.com/a.jpg${LOCAL_ATTACHMENT_FRAGMENT}u%2Fa.jpg`,
    ],
    ["an attachment URL", "attachment://u/n/a.jpg"],
    ["a marker with no path", `${FILE_URI}${LOCAL_ATTACHMENT_FRAGMENT}`],
    ["a malformed encoding", `${FILE_URI}${LOCAL_ATTACHMENT_FRAGMENT}%E0%A4%A`],
    ["an empty string", ""],
  ])("is not a local src: %s", (_label, url) => {
    expect(isLocalAttachmentSrc(url)).toBe(false);
    expect(extractFilePathFromLocalSrc(url)).toBeNull();
  });
});

describe("attachmentCacheRelativePath", () => {
  const SAFE_NAME = /^[a-z0-9 _!\-.'()&$@=;+,~]+$/;
  const HASHED = /~[0-9a-f]{16}/;

  it("keeps a storage-safe, lower-case path as it is", () => {
    expect(attachmentCacheRelativePath("user-1/note-1/photo-1-abc.jpg")).toBe(
      "user-1/note-1/photo-1-abc.jpg",
    );
  });

  it("makes a changed segment filesystem-safe, with a hash of the original before the extension", () => {
    const path = attachmentCacheRelativePath("u/n/we#ird%name?.jpg");
    expect(path).toMatch(/^u\/n\/we_ird_name_~[0-9a-f]{16}\.jpg$/);
  });

  it.each([
    ["u/n/café.png", "u/n/cafe.png"],
    ["u/n/photo#1.png", "u/n/photo_1.png"],
    ["u/n/Photo.png", "u/n/photo.png"],
    ["u/n/a?.png", "u/n/a#.png"],
    ["u//n/a.png", "u/n/a.png"],
    ["u/n/.a", "u/n/a"],
  ])("gives %s and %s different files", (first, second) => {
    expect(attachmentCacheRelativePath(first)).not.toBe(attachmentCacheRelativePath(second));
  });

  it("is the same for the same storage path", () => {
    expect(attachmentCacheRelativePath("u/n/café.png")).toBe(
      attachmentCacheRelativePath("u/n/café.png"),
    );
  });

  it("never lets a segment climb out of the cache directory or hide a file", () => {
    for (const path of ["../../etc/passwd", "./u//n/a.jpg", "u/.partial", "u/.index.json"]) {
      for (const segment of attachmentCacheRelativePath(path).split("/")) {
        expect(segment).not.toMatch(/^\./);
        expect(segment).toMatch(SAFE_NAME);
      }
    }
    expect(attachmentCacheRelativePath("../../etc/passwd")).toMatch(/\/etc\/passwd$/);
  });

  it("maps empty segments to names of their own", () => {
    expect(attachmentCacheRelativePath("")).toMatch(/^_~[0-9a-f]{16}$/);
    expect(attachmentCacheRelativePath("///").split("/")).toHaveLength(4);
  });

  it("keeps every name within 255 characters and its extension", () => {
    const name = attachmentCacheRelativePath(`u/n/${"É".repeat(300)}.jpeg`).split("/")[2];
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name).toMatch(HASHED);
    expect(name.endsWith(".jpeg")).toBe(true);
  });
});
