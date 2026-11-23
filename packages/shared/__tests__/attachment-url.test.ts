import { describe, expect, it } from "vitest";
import {
  toAttachmentUrl,
  isAttachmentUrl,
  extractFilePath,
  isSignedStorageUrl,
  extractFilePathFromSignedUrl,
  canonicalAttachmentUrl,
  toLocalAttachmentSrc,
  isAttachmentFileName,
} from "../src/editor/attachment-url";
import { buildAttachmentStoragePath, safeAttachmentFileName } from "../src/storage/storage-key";

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

describe("PrimeTestLab 11035 S-04 canonicalAttachmentUrl", () => {
  it("maps a signed URL to its attachment:// URL, decoding the path", () => {
    expect(
      canonicalAttachmentUrl(
        "https://x.supabase.co/storage/v1/object/sign/attachments/u/n/my%20file.pdf?token=t",
      ),
    ).toBe("attachment://u/n/my file.pdf");
  });

  it("maps a local cached src to its attachment:// URL", () => {
    expect(
      canonicalAttachmentUrl(toLocalAttachmentSrc("file:///cache/u/n/a.png", "u/n/a.png")),
    ).toBe("attachment://u/n/a.png");
  });

  it("is null for any other URL, attachment:// included", () => {
    expect(canonicalAttachmentUrl("https://example.com/a.pdf")).toBeNull();
    expect(canonicalAttachmentUrl("attachment://u/n/a.pdf")).toBeNull();
  });
});

describe("isAttachmentFileName — PrimeTestLab 11035 review", () => {
  it("matches the name the native editors insert (the safe name, no unique suffix)", () => {
    const raw = "Quarterly report (v2).pdf";
    const { filePath } = buildAttachmentStoragePath(raw, "user-1", "note-1");
    expect(isAttachmentFileName(safeAttachmentFileName(raw), filePath)).toBe(true);
  });

  it("matches the raw name a web file block carries", () => {
    const raw = "Résumé #2.pdf";
    const { filePath } = buildAttachmentStoragePath(raw, "user-1", "note-1");
    expect(isAttachmentFileName(raw, filePath)).toBe(true);
  });

  it("matches the key's own segment, as the web's attachment rows are named", () => {
    const { fileName, filePath } = buildAttachmentStoragePath("report.pdf", "user-1", "note-1");
    expect(isAttachmentFileName(fileName, filePath)).toBe(true);
  });

  it("matches an older key with no unique suffix on its exact name", () => {
    expect(isAttachmentFileName("report.pdf", "user-1/note-1/report.pdf")).toBe(true);
    expect(isAttachmentFileName("other.pdf", "user-1/note-1/report.pdf")).toBe(false);
  });

  it("matches a long name whose key cut its base short", () => {
    const raw = `${"a".repeat(300)}.pdf`;
    const { filePath, fileName } = buildAttachmentStoragePath(raw, "user-1", "note-1");
    expect(fileName).toHaveLength(255);
    expect(isAttachmentFileName(safeAttachmentFileName(raw), filePath)).toBe(true);
    expect(isAttachmentFileName(`${"a".repeat(300)}.txt`, filePath)).toBe(false);
  });

  it("matches a name whose key kept only the first 20 characters of its extension", () => {
    for (const raw of ["Dr. Smith referral letter scan", "notes.markdown-backup-2024"]) {
      const { filePath } = buildAttachmentStoragePath(raw, "user-1", "note-1");
      expect(isAttachmentFileName(safeAttachmentFileName(raw), filePath)).toBe(true);
      expect(isAttachmentFileName(raw, filePath)).toBe(true);
    }
  });

  it("matches a long name with a long extension whose key cut both short", () => {
    const raw = `${"a".repeat(300)}. Smith referral letter scan`;
    const { filePath, fileName } = buildAttachmentStoragePath(raw, "user-1", "note-1");
    expect(fileName).toHaveLength(255);
    expect(isAttachmentFileName(safeAttachmentFileName(raw), filePath)).toBe(true);
    expect(isAttachmentFileName(raw, filePath)).toBe(true);
    expect(isAttachmentFileName(`${"b".repeat(300)}. Smith referral letter scan`, filePath)).toBe(
      false,
    );
  });

  it("does not match a name whose capped extension differs from the key's", () => {
    const { filePath } = buildAttachmentStoragePath(
      "Dr. Smith referral letter scan",
      "user-1",
      "note-1",
    );
    expect(isAttachmentFileName("Dr. Jones referral letter scan", filePath)).toBe(false);
    expect(isAttachmentFileName("Dr", filePath)).toBe(false);
  });

  it("does not match other link text", () => {
    const { filePath } = buildAttachmentStoragePath("photo.jpg", "user-1", "note-1");
    expect(isAttachmentFileName("my holiday", filePath)).toBe(false);
    expect(isAttachmentFileName("photo.png", filePath)).toBe(false);
    expect(isAttachmentFileName("", filePath)).toBe(false);
    expect(
      isAttachmentFileName(
        `https://x.supabase.co/storage/v1/object/sign/attachments/${filePath}?token=t`,
        filePath,
      ),
    ).toBe(false);
  });
});
