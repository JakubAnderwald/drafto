import { getRandomValues } from "expo-crypto";

type IntegerTypedArray =
  Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array;

function isIntegerTypedArray(value: ArrayBufferView | null): value is IntegerTypedArray {
  return (
    value instanceof Int8Array ||
    value instanceof Uint8Array ||
    value instanceof Uint8ClampedArray ||
    value instanceof Int16Array ||
    value instanceof Uint16Array ||
    value instanceof Int32Array ||
    value instanceof Uint32Array
  );
}

/** `crypto.getRandomValues`, backed by expo-crypto (the OS CSPRNG). */
function fillRandom<T extends ArrayBufferView | null>(array: T): T {
  if (!isIntegerTypedArray(array)) {
    throw new TypeError("crypto.getRandomValues: expected an integer typed array");
  }
  getRandomValues(array);
  return array;
}

/**
 * Gives supabase-js a cryptographic random source for its PKCE `code_verifier`
 * (ADR-0045).
 *
 * Hermes has no global `crypto`, and without one supabase-js builds the verifier
 * from `Math.random()`. Only `getRandomValues` is installed. With no
 * `crypto.subtle`, supabase-js still sends a `plain` challenge, which ties the
 * code to this device's stored verifier all the same. Leaves a runtime that
 * already has `crypto.getRandomValues` untouched.
 */
export function installCryptoRandom(): void {
  const scope = globalThis as { crypto?: Partial<Crypto> };
  if (typeof scope.crypto?.getRandomValues === "function") return;
  scope.crypto = { ...scope.crypto, getRandomValues: fillRandom };
}
