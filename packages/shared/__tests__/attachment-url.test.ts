import { describe, expect, it } from "vitest";
import {
  toAttachmentUrl,
  isAttachmentUrl,
  extractFilePath,
  isSignedStorageUrl,
  extractFilePathFromSignedUrl,
} from "../src/editor/attachment-url";

describe("attachment-url helpers", () => {
  describe("toAttachmentUrl", () => {
    it("creates attachment:// URL from file path", () => {
      expect(toAttachmentUrl("user-1/note-1/image.jpg")).toBe(
        "attachment://user-1/note-1/image.jpg",
      );
    });

    it("handles paths with special characters", () => {
      expect(toAttachmentUrl("user-1/note-1/my image (1).jpg")).toBe(
        "attachment://user-1/note-1/my image (1).jpg",
      );
    });
  });

  describe("isAttachmentUrl", () => {
    it("returns true for attachment:// URLs", () => {
      expect(isAttachmentUrl("attachment://user-1/note-1/image.jpg")).toBe(true);
    });

    it("returns false for regular URLs", () => {
      expect(isAttachmentUrl("https://example.com/image.jpg")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isAttachmentUrl("")).toBe(false);
    });
  });

  describe("extractFilePath", () => {
    it("strips attachment:// prefix", () => {
      expect(extractFilePath("attachment://user-1/note-1/image.jpg")).toBe(
        "user-1/note-1/image.jpg",
      );
    });
  });

  describe("round-trip", () => {
    it("toAttachmentUrl -> extractFilePath returns original path", () => {
      const path = "user-1/note-1/photo.png";
      expect(extractFilePath(toAttachmentUrl(path))).toBe(path);
    });

    it("toAttachmentUrl -> isAttachmentUrl returns true", () => {
      expect(isAttachmentUrl(toAttachmentUrl("any/path.jpg"))).toBe(true);
    });
  });

  describe("isSignedStorageUrl", () => {
    it("detects Supabase signed URLs", () => {
      const url =
        "https://abc.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/img.jpg?token=xyz";
      expect(isSignedStorageUrl(url)).toBe(true);
    });

    it("rejects non-Supabase URLs", () => {
      expect(isSignedStorageUrl("https://example.com/image.jpg")).toBe(false);
    });

    it("rejects attachment:// URLs", () => {
      expect(isSignedStorageUrl("attachment://user-1/note-1/img.jpg")).toBe(false);
    });
  });

  describe("extractFilePathFromSignedUrl", () => {
    it("extracts file path from signed URL", () => {
      const url =
        "https://abc.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/img.jpg?token=xyz";
      expect(extractFilePathFromSignedUrl(url)).toBe("user-1/note-1/img.jpg");
    });

    it("handles URL-encoded paths", () => {
      const url =
        "https://abc.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/my%20image.jpg?token=xyz";
      expect(extractFilePathFromSignedUrl(url)).toBe("user-1/note-1/my image.jpg");
    });

    it("returns null for non-matching URLs", () => {
      expect(extractFilePathFromSignedUrl("https://example.com/image.jpg")).toBeNull();
    });
  });
});
