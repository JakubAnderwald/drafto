/**
 * Generate a UUID v4.
 * Uses the global crypto API available in React Native's Hermes runtime.
 */

declare const globalThis: { crypto: { getRandomValues: (array: Uint8Array) => Uint8Array } };

export function generateId(): string {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => {
    const n = Number(c);
    return (
      n ^
      (globalThis.crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (n / 4)))
    ).toString(16);
  });
}
