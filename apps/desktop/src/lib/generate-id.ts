/**
 * Generate a UUID v4 (RFC 4122).
 * Uses crypto.getRandomValues when available (modern Hermes),
 * falls back to Math.random for older runtimes.
 */
export function generateId(): string {
  const bytes = new Uint8Array(16);

  const crypto = (globalThis as Record<string, unknown>).crypto as
    | { getRandomValues: (array: Uint8Array) => Uint8Array }
    | undefined;
  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback for Hermes versions without Web Crypto
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122 v4: set version (4) and variant (10xx) bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
