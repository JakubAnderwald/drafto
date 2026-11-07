import { describe, expect, it } from "vitest";

import {
  buildAttachmentStoragePath,
  isStorageSafeFileName,
  localAttachmentFileName,
  safeAttachmentFileName,
  toStorageSafeFileName,
  truncateFileName,
} from "../src/storage/storage-key";

const USER_ID = "3b39a3fa-d37e-478e-aa3c-d7377c465529";
const NOTE_ID = "99ba04b8-949a-4727-a464-345fdaa7441d";
const COMBINING_DIAERESIS = String.fromCharCode(0x308);
const NUL = String.fromCharCode(0);
const SUFFIX = String.raw`-\d+-[0-9a-f]{8}`;

describe("toStorageSafeFileName", () => {
  it("leaves ordinary names unchanged", () => {
    expect(toStorageSafeFileName("photo.jpg")).toBe("photo.jpg");
    expect(toStorageSafeFileName("Sandra och Michelle (1).docx")).toBe(
      "Sandra och Michelle (1).docx",
    );
  });

  it("keeps the punctuation Supabase Storage accepts in a URL path", () => {
    expect(toStorageSafeFileName("a b_!-.'()&$@=;+,.txt")).toBe("a b_!-.'()&$@=;+,.txt");
  });

  it("replaces # so the URL fragment cannot cut the key short", () => {
    expect(toStorageSafeFileName("Sandra & Michelle #40 - Om att bli gamla.mp3")).toBe(
      "Sandra & Michelle _40 - Om att bli gamla.mp3",
    );
  });

  it("replaces characters Storage rejects with a 400", () => {
    expect(toStorageSafeFileName("100% done ~v2 [final] {x} ^y `z`.pdf")).toBe(
      "100_ done _v2 _final_ _x_ _y _z_.pdf",
    );
  });

  it("replaces path, filesystem and control characters", () => {
    expect(toStorageSafeFileName(`a/b\\c:d*e?f"g<h>i|j${NUL}k.txt`)).toBe(
      "a_b_c_d_e_f_g_h_i_j_k.txt",
    );
  });

  it("strips directory traversal", () => {
    expect(toStorageSafeFileName("../../../etc/passwd")).toBe("______etc_passwd");
  });

  it("keeps the base letter of accented characters (NFC and NFD input)", () => {
    expect(toStorageSafeFileName("partikelverb Aöb(1).pdf")).toBe("partikelverb Aob(1).pdf");
    expect(toStorageSafeFileName(`partikelverb Ao${COMBINING_DIAERESIS}b(1).pdf`)).toBe(
      "partikelverb Aob(1).pdf",
    );
    expect(toStorageSafeFileName("café résumé naïve.pdf")).toBe("cafe resume naive.pdf");
  });

  it("replaces emoji and non-Latin scripts", () => {
    expect(toStorageSafeFileName("文件 🎉.txt")).toBe("__ __.txt");
  });
});

describe("isStorageSafeFileName", () => {
  it("accepts names the sanitizer leaves alone", () => {
    expect(isStorageSafeFileName("Sandra & Michelle _40-1781419248539-8c338d38.mp3")).toBe(true);
  });

  it("rejects empty names and names the sanitizer would change", () => {
    expect(isStorageSafeFileName("")).toBe(false);
    expect(isStorageSafeFileName("Show #40.mp3")).toBe(false);
    expect(isStorageSafeFileName("a/b.png")).toBe(false);
    expect(isStorageSafeFileName("100%.pdf")).toBe(false);
  });
});

describe("truncateFileName", () => {
  it("returns short names unchanged", () => {
    expect(truncateFileName("doc.pdf", 255)).toBe("doc.pdf");
  });

  it("cuts the base name and keeps the extension", () => {
    const result = truncateFileName(`${"a".repeat(300)}.pdf`, 255);
    expect(result).toHaveLength(255);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("cuts names without an extension", () => {
    expect(truncateFileName("a".repeat(300), 10)).toBe("a".repeat(10));
  });
});

describe("safeAttachmentFileName", () => {
  it("sanitizes and caps at 255 characters with the extension kept", () => {
    expect(safeAttachmentFileName("Show #40.mp3")).toBe("Show _40.mp3");
    const long = safeAttachmentFileName(`${"a".repeat(300)}.txt`);
    expect(long).toHaveLength(255);
    expect(long.endsWith(".txt")).toBe(true);
  });
});

describe("buildAttachmentStoragePath", () => {
  it("builds <user>/<note>/<safe name><suffix><ext>", () => {
    const { fileName, filePath } = buildAttachmentStoragePath(
      "Sandra & Michelle #40 - Om att bli gamla.mp3",
      USER_ID,
      NOTE_ID,
    );

    expect(fileName).toMatch(
      new RegExp(`^Sandra & Michelle _40 - Om att bli gamla${SUFFIX}\\.mp3$`),
    );
    expect(filePath).toBe(`${USER_ID}/${NOTE_ID}/${fileName}`);
    expect(isStorageSafeFileName(fileName)).toBe(true);
  });

  it("normalises accented characters (DRAFTO-P regression)", () => {
    const { fileName } = buildAttachmentStoragePath("partikelverb Aöb(1).pdf", USER_ID, NOTE_ID);
    expect(fileName).toMatch(new RegExp(`^partikelverb Aob\\(1\\)${SUFFIX}\\.pdf$`));
  });

  it("strips path traversal so the key stays three segments", () => {
    const { fileName, filePath } = buildAttachmentStoragePath("../etc/passwd", USER_ID, NOTE_ID);
    expect(fileName).not.toContain("..");
    expect(filePath.split("/")).toHaveLength(3);
  });

  it("keeps the file name within 255 characters and keeps the extension", () => {
    const { fileName } = buildAttachmentStoragePath(`${"a".repeat(400)}.pdf`, USER_ID, NOTE_ID);
    expect(fileName.length).toBeLessThanOrEqual(255);
    expect(fileName.endsWith(".pdf")).toBe(true);
  });

  it("handles names without an extension", () => {
    const { fileName } = buildAttachmentStoragePath("README", USER_ID, NOTE_ID);
    expect(fileName).toMatch(new RegExp(`^README${SUFFIX}$`));
  });

  it("gives names that sanitize alike different keys", () => {
    const a = buildAttachmentStoragePath("Episode #40.mp3", USER_ID, NOTE_ID);
    const b = buildAttachmentStoragePath("Episode _40.mp3", USER_ID, NOTE_ID);
    const c = buildAttachmentStoragePath("Episode _40.mp3", USER_ID, NOTE_ID);
    expect(new Set([a.filePath, b.filePath, c.filePath]).size).toBe(3);
  });
});

describe("localAttachmentFileName", () => {
  const id = "a".repeat(20);

  it("prefixes the id to the safe name", () => {
    expect(localAttachmentFileName(id, "Show #40.mp3")).toBe(`${id}_Show _40.mp3`);
  });

  it("stays within the 255-byte filename limit with the extension kept", () => {
    const result = localAttachmentFileName(id, `${"b".repeat(300)}.pdf`);
    expect(result).toHaveLength(255);
    expect(result.endsWith(".pdf")).toBe(true);
  });
});
