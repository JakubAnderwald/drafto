import { sanitizeFileName } from "@/lib/data/attachment-utils";

describe("sanitizeFileName", () => {
  it("returns simple filenames unchanged", () => {
    expect(sanitizeFileName("photo.jpg")).toBe("photo.jpg");
  });

  it("replaces forward slashes", () => {
    expect(sanitizeFileName("path/to/file.txt")).toBe("path_to_file.txt");
  });

  it("replaces backslashes", () => {
    expect(sanitizeFileName("path\\to\\file.txt")).toBe("path_to_file.txt");
  });

  it("replaces double dots", () => {
    expect(sanitizeFileName("../../../etc/passwd")).toBe("______etc_passwd");
  });

  it("replaces special characters", () => {
    expect(sanitizeFileName('file<>:"|?*.txt')).toBe("file_______.txt");
  });

  it("replaces control characters", () => {
    expect(sanitizeFileName("file\x00\x01name.txt")).toBe("file__name.txt");
  });

  it("truncates to 255 characters", () => {
    const longName = "a".repeat(300) + ".txt";
    expect(sanitizeFileName(longName).length).toBe(255);
  });

  it("handles empty string", () => {
    expect(sanitizeFileName("")).toBe("");
  });

  it("strips NFD-decomposed combining marks (macOS filesystem encoding)", () => {
    // macOS returns filenames in NFD — "ö" is stored as "o" + U+0308 (combining diaeresis).
    // Without this, the filename lands in Supabase Storage where its key regex rejects non-ASCII.
    const nfd = "partikelverb Aöb(1).pdf";
    expect(sanitizeFileName(nfd)).toBe("partikelverb Aob(1).pdf");
  });

  it("strips NFC precomposed accented characters via NFD normalisation", () => {
    const nfc = "partikelverb Aöb(1).pdf";
    expect(sanitizeFileName(nfc)).toBe("partikelverb Aob(1).pdf");
  });

  it("replaces non-Latin characters (CJK, emoji) with underscores", () => {
    expect(sanitizeFileName("hello 🎉.txt")).toMatch(/^hello _+\.txt$/);
    expect(sanitizeFileName("文件.txt")).toBe("__.txt");
  });

  it("produces ASCII-only output for Supabase Storage keys", () => {
    const result = sanitizeFileName("café résumé naïve.pdf");
    expect(result).toBe("cafe resume naive.pdf");
    expect(result).toMatch(/^[\x20-\x7e]*$/);
  });
});
