/**
 * Minimal store-only ZIP writer.
 *
 * Emits a standards-compliant ZIP archive containing the given files with the
 * `store` method (compression method 0 — no compression). That keeps the
 * implementation small (one CRC32 pass per entry, no deflate dependency) at
 * the cost of a slightly larger archive. Good enough for the .enex bundle
 * use case where the payload is already text + base64 attachment data.
 *
 * Layout per the PKZIP APPNOTE.TXT §4:
 *   [Local File Header + name + data]+
 *   [Central Directory File Header + name]+
 *   [End of Central Directory Record]
 */
export interface ZipEntry {
  /** File path inside the archive. Use forward slashes for directories. */
  name: string;
  /** Raw file bytes. */
  data: Uint8Array;
}

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION = 20;
const METHOD_STORE = 0;

export function createZip(entries: ZipEntry[], modDate: Date = new Date()): Uint8Array {
  const { dosTime, dosDate } = toDosDateTime(modDate);
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.byteLength;

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lfhView = new DataView(lfh.buffer);
    lfhView.setUint32(0, SIG_LFH, true);
    lfhView.setUint16(4, VERSION, true);
    lfhView.setUint16(6, 0, true); // flags
    lfhView.setUint16(8, METHOD_STORE, true);
    lfhView.setUint16(10, dosTime, true);
    lfhView.setUint16(12, dosDate, true);
    lfhView.setUint32(14, crc, true);
    lfhView.setUint32(18, size, true);
    lfhView.setUint32(22, size, true);
    lfhView.setUint16(26, nameBytes.length, true);
    lfhView.setUint16(28, 0, true); // extra length
    lfh.set(nameBytes, 30);

    localChunks.push(lfh, entry.data);

    const cdh = new Uint8Array(46 + nameBytes.length);
    const cdhView = new DataView(cdh.buffer);
    cdhView.setUint32(0, SIG_CDH, true);
    cdhView.setUint16(4, VERSION, true); // version made by
    cdhView.setUint16(6, VERSION, true); // version needed
    cdhView.setUint16(8, 0, true); // flags
    cdhView.setUint16(10, METHOD_STORE, true);
    cdhView.setUint16(12, dosTime, true);
    cdhView.setUint16(14, dosDate, true);
    cdhView.setUint32(16, crc, true);
    cdhView.setUint32(20, size, true);
    cdhView.setUint32(24, size, true);
    cdhView.setUint16(28, nameBytes.length, true);
    cdhView.setUint16(30, 0, true); // extra length
    cdhView.setUint16(32, 0, true); // comment length
    cdhView.setUint16(34, 0, true); // disk number
    cdhView.setUint16(36, 0, true); // internal attrs
    cdhView.setUint32(38, 0, true); // external attrs
    cdhView.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);

    centralChunks.push(cdh);

    offset += lfh.length + size;
  }

  const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, SIG_EOCD, true);
  eocdView.setUint16(4, 0, true); // disk number
  eocdView.setUint16(6, 0, true); // disk with CD
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);
  eocdView.setUint16(20, 0, true); // comment length

  const total = localChunks.reduce((sum, c) => sum + c.length, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of localChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  for (const chunk of centralChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  out.set(eocd, pos);
  return out;
}

const textEncoder = new TextEncoder();

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  // DOS time/date in local time per the spec.
  const year = Math.max(1980, safe.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate();
  const dosTime =
    (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2);
  return { dosTime, dosDate };
}
