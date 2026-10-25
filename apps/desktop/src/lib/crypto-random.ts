import { getCryptoModule, type CryptoModule } from "@/lib/native/crypto-module";

type IntegerTypedArray =
  Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array;

/** The two members supabase-js uses. */
type InstalledCrypto = {
  getRandomValues?: Crypto["getRandomValues"];
  subtle?: Pick<SubtleCrypto, "digest">;
};

/** WebCrypto's per-call limit for `getRandomValues`. */
const MAX_RANDOM_BYTES = 65536;

const SHA256_BYTES = 32;

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

function isByteArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * `crypto.getRandomValues`, backed by `SecRandomCopyBytes`. Throws instead of
 * ever returning bytes the native side didn't fill, so a failure blocks the
 * sign-in rather than weakening its verifier.
 */
function createGetRandomValues(native: CryptoModule): Crypto["getRandomValues"] {
  return function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    if (!isIntegerTypedArray(array)) {
      throw new TypeError("crypto.getRandomValues: expected an integer typed array");
    }
    if (array.byteLength > MAX_RANDOM_BYTES) {
      throw namedError(
        "QuotaExceededError",
        `crypto.getRandomValues: ${array.byteLength} bytes is over the ${MAX_RANDOM_BYTES}-byte limit`,
      );
    }
    if (array.byteLength === 0) return array;

    const bytes = native.randomBytes(array.byteLength);
    if (!isByteArray(bytes, array.byteLength)) {
      throw new Error("crypto.getRandomValues: the system random source failed");
    }
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    return array;
  };
}

function toBytes(data: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("crypto.subtle.digest: expected an ArrayBuffer or an ArrayBuffer view");
}

/** `crypto.subtle.digest` for SHA-256 only, backed by CommonCrypto. */
function createDigest(native: CryptoModule): SubtleCrypto["digest"] {
  return async function digest(
    algorithm: AlgorithmIdentifier,
    data: BufferSource,
  ): Promise<ArrayBuffer> {
    const name = typeof algorithm === "string" ? algorithm : algorithm?.name;
    if (typeof name !== "string" || name.toUpperCase() !== "SHA-256") {
      throw namedError("NotSupportedError", "crypto.subtle.digest: only SHA-256 is supported");
    }
    const hash = await native.sha256(Array.from(toBytes(data)));
    if (!isByteArray(hash, SHA256_BYTES)) {
      throw new Error("crypto.subtle.digest: the system SHA-256 failed");
    }
    return Uint8Array.from(hash).buffer;
  };
}

/** A module that is linked but broken (the bridge returns nothing) must not reach auth-js. */
function canDrawRandomBytes(native: CryptoModule): boolean {
  try {
    return isByteArray(native.randomBytes(1), 1);
  } catch {
    return false;
  }
}

/** SHA-256("abc"), the FIPS 180-2 test vector. */
const SELF_TEST_INPUT = [0x61, 0x62, 0x63];
const SELF_TEST_DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** Whether the async `sha256` round trip works, so a broken one never reaches auth-js. */
async function hashesCorrectly(native: CryptoModule): Promise<boolean> {
  try {
    const hash = await native.sha256(SELF_TEST_INPUT);
    if (!isByteArray(hash, SHA256_BYTES)) return false;
    return hash.map((byte) => byte.toString(16).padStart(2, "0")).join("") === SELF_TEST_DIGEST;
  } catch {
    return false;
  }
}

/**
 * Adds a member to the runtime's `crypto` in place, so members it already has
 * (often on a prototype, bound to the object) survive. False if it can't.
 */
function addMember(target: InstalledCrypto, name: keyof InstalledCrypto, value: unknown): boolean {
  try {
    Object.defineProperty(target, name, {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    return true;
  } catch {
    console.warn(`[crypto] could not add crypto.${name}; the runtime's crypto is left as is`);
    return false;
  }
}

/**
 * Gives supabase-js a cryptographic random source for its PKCE `code_verifier`,
 * and SHA-256 for an S256 challenge, from the in-project `DraftoCrypto` native
 * module (ADR-0059).
 *
 * Hermes on react-native-macos has no global `crypto`, and without one
 * supabase-js builds the verifier from `Math.random()` and sends it as a
 * `plain` challenge. Each missing member is installed on its own, and a
 * runtime that already has one keeps it.
 *
 * Each install step checks the native side first, and skips what fails, so
 * supabase-js keeps its own behaviour rather than breaking sign-in:
 * - Installs nothing when the module is absent (Jest, CI) or fails a one-byte
 *   probe.
 * - `getRandomValues` is installed at once. `subtle` follows when the returned
 *   promise settles, and only after a native SHA-256 self-test passes, because
 *   supabase-js stops falling back to `plain` as soon as `crypto.subtle` exists.
 * - `subtle` also needs `TextEncoder` and `btoa`: supabase-js checks for the
 *   first but calls `btoa` unguarded, so `subtle` without it would throw
 *   mid-sign-in.
 *
 * `subtle` has `digest` only. `supabase.auth.getClaims()` would see it and try
 * `subtle.importKey` on an asymmetric JWT, so add `importKey` and `verify`
 * before the app ever calls it. `generateId` also picks up `getRandomValues`.
 */
export async function installCryptoRandom(): Promise<void> {
  const scope = globalThis as { crypto?: InstalledCrypto };
  const needsRandom = typeof scope.crypto?.getRandomValues !== "function";
  const needsSubtle =
    typeof scope.crypto?.subtle === "undefined" &&
    typeof TextEncoder === "function" &&
    typeof btoa === "function";
  if (!needsRandom && !needsSubtle) return;

  const native = getCryptoModule();
  if (!native) return;
  if (!canDrawRandomBytes(native)) {
    console.warn("[crypto] DraftoCrypto returned no random bytes; crypto was not installed");
    return;
  }

  let target = scope.crypto;
  if (!target) {
    target = {};
    scope.crypto = target;
  }
  if (needsRandom && !addMember(target, "getRandomValues", createGetRandomValues(native))) return;
  if (!needsSubtle) return;

  if (!(await hashesCorrectly(native))) {
    console.warn(
      "[crypto] DraftoCrypto failed its SHA-256 self-test; the PKCE challenge stays plain",
    );
    return;
  }
  // Something else may have installed one while the self-test ran.
  if (typeof target.subtle === "undefined") {
    addMember(target, "subtle", { digest: createDigest(native) });
  }
}
