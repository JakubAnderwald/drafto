import { describe, expect, it } from "vitest";
import { sanitizeAndBuildPath } from "@/lib/api/sanitize-filename";

const USER_ID = "3b39a3fa-d37e-478e-aa3c-d7377c465529";
const NOTE_ID = "99ba04b8-949a-4727-a464-345fdaa7441d";

describe("sanitizeAndBuildPath", () => {
  it("normalises accented characters to their ASCII base (DRAFTO-P regression)", () => {
    const { fileName, filePath } = sanitizeAndBuildPath(
      "partikelverb Aöb(1).pdf",
      USER_ID,
      NOTE_ID,
    );

    expect(fileName).toMatch(/^partikelverb Aob\(1\)-\d+-[0-9a-f]{8}\.pdf$/);
    expect(fileName).not.toMatch(/ö/);
    expect(filePath).toBe(`${USER_ID}/${NOTE_ID}/${fileName}`);
    // The whole key must be printable ASCII — that's what Supabase Storage requires.
    expect(filePath).toMatch(/^[\x20-\x7e]+$/);
  });

  it("replaces emoji and other non-ASCII codepoints with underscores", () => {
    const { fileName } = sanitizeAndBuildPath("hello 👋 漢字.png", USER_ID, NOTE_ID);

    expect(fileName).toMatch(/^hello __ __-\d+-[0-9a-f]{8}\.png$/);
  });

  it("strips path traversal sequences", () => {
    const { fileName, filePath } = sanitizeAndBuildPath("../etc/passwd", USER_ID, NOTE_ID);

    expect(fileName).not.toContain("..");
    expect(fileName).not.toContain("/");
    expect(filePath.startsWith(`${USER_ID}/${NOTE_ID}/`)).toBe(true);
    expect(filePath.split("/")).toHaveLength(3);
  });

  it("keeps the file name within the Supabase 255-char limit", () => {
    const longBase = "a".repeat(400);
    const { fileName } = sanitizeAndBuildPath(`${longBase}.pdf`, USER_ID, NOTE_ID);

    expect(fileName.length).toBeLessThanOrEqual(255);
    expect(fileName.endsWith(".pdf")).toBe(true);
  });

  it("handles names without an extension", () => {
    const { fileName } = sanitizeAndBuildPath("README", USER_ID, NOTE_ID);

    expect(fileName).toMatch(/^README-\d+-[0-9a-f]{8}$/);
    expect(fileName.startsWith(".")).toBe(false);
  });

  it("produces a unique path on every call (collision-safe suffix)", () => {
    const a = sanitizeAndBuildPath("photo.jpg", USER_ID, NOTE_ID);
    const b = sanitizeAndBuildPath("photo.jpg", USER_ID, NOTE_ID);

    expect(a.filePath).not.toBe(b.filePath);
  });
});
