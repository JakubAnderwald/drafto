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
  it("keeps a storage-safe path as it is", () => {
    expect(attachmentCacheRelativePath("user-1/note-1/photo-1-abc.jpg")).toBe(
      "user-1/note-1/photo-1-abc.jpg",
    );
  });

  it("makes each segment filesystem-safe", () => {
    expect(attachmentCacheRelativePath("u/n/we#ird%name?.jpg")).toBe("u/n/we_ird_name_.jpg");
  });

  it("never lets a segment climb out of the cache directory", () => {
    expect(attachmentCacheRelativePath("../../etc/passwd")).toBe("_/_/etc/passwd");
    expect(attachmentCacheRelativePath("./u//n/a.jpg")).toBe("_/u/n/a.jpg");
  });

  it("maps an empty path to a placeholder", () => {
    expect(attachmentCacheRelativePath("")).toBe("_");
    expect(attachmentCacheRelativePath("///")).toBe("_");
  });
});
