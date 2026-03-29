/**
 * Generate a UUID v4 (RFC 4122).
 * Uses the global crypto API available in React Native's Hermes runtime.
 */

declare const globalThis: { crypto: { getRandomValues: (array: Uint8Array) => Uint8Array } };

export function generateId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));

  // RFC 4122 v4: set version (4) and variant (10xx) bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
