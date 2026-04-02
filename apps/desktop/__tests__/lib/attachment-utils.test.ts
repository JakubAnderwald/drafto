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
});
