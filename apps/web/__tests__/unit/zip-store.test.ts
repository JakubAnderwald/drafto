import { describe, it, expect } from "vitest";

import { createZip } from "@/lib/export/zip-store";

const decoder = new TextDecoder("utf-8");

/**
 * Minimal reader for store-only zips, sufficient to verify createZip's output
 * without pulling an external decoder into the test surface.
 */
function readStoreZip(zip: Uint8Array): Record<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: Record<string, string> = {};
  let i = 0;
  while (i < zip.length - 4) {
    const sig = view.getUint32(i, true);
    if (sig !== 0x04034b50) break;
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const compressedSize = view.getUint32(i + 18, true);
    const nameStart = i + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = decoder.decode(zip.subarray(nameStart, nameStart + nameLen));
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    entries[name] = decoder.decode(data);
    i = dataStart + compressedSize;
  }
  return entries;
}

describe("createZip", () => {
  it("produces a valid zip with one entry that decodes back to the original bytes", () => {
    const data = new TextEncoder().encode("hello world");
    const zip = createZip([{ name: "hello.txt", data }]);

    const extracted = readStoreZip(zip);
    expect(Object.keys(extracted)).toEqual(["hello.txt"]);
    expect(extracted["hello.txt"]).toBe("hello world");
  });

  it("preserves multiple entries in input order", () => {
    const a = new TextEncoder().encode("first");
    const b = new TextEncoder().encode("second");
    const c = new TextEncoder().encode("third");
    const zip = createZip([
      { name: "a.enex", data: a },
      { name: "b.enex", data: b },
      { name: "c.enex", data: c },
    ]);

    const extracted = readStoreZip(zip);
    expect(Object.keys(extracted)).toEqual(["a.enex", "b.enex", "c.enex"]);
    expect(extracted["a.enex"]).toBe("first");
    expect(extracted["b.enex"]).toBe("second");
    expect(extracted["c.enex"]).toBe("third");
  });

  it("starts with the ZIP local-file-header signature PK\\x03\\x04", () => {
    const zip = createZip([{ name: "x", data: new Uint8Array([1, 2, 3]) }]);
    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  it("uses store method (compressed size === uncompressed size)", () => {
    const bytes = new TextEncoder().encode("a".repeat(200));
    const zip = createZip([{ name: "blob", data: bytes }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Local file header method field at offset 8 must be 0 (store).
    expect(view.getUint16(8, true)).toBe(0);
    // Compressed size === uncompressed size for stored entries.
    expect(view.getUint32(18, true)).toBe(view.getUint32(22, true));
  });

  it("ends with the EOCD record so standard unzip tools can locate the central directory", () => {
    const zip = createZip([
      { name: "one", data: new TextEncoder().encode("1") },
      { name: "two", data: new TextEncoder().encode("22") },
    ]);
    // EOCD signature is at length-22 when there's no trailing comment.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocdOffset = zip.length - 22;
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(eocdOffset + 10, true)).toBe(2); // total entries
  });
});
