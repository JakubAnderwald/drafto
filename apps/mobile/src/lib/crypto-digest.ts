import { CryptoDigestAlgorithm, digest } from "expo-crypto";

/** The one member of `crypto.subtle` installed here. */
type DigestOnlySubtle = Pick<SubtleCrypto, "digest">;

type CryptoScope = {
  crypto?: Omit<Partial<Crypto>, "subtle"> & { subtle?: DigestOnlySubtle };
};

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Copies the bytes `data` covers into a fresh `Uint8Array`. expo-crypto's native
 * `digest` takes a typed array only, not an `ArrayBuffer` or `DataView`. A copy
 * also starts at offset 0 of a buffer of its own, so the native side hashes
 * exactly the bytes the caller passed, whatever view they came in.
 */
function toBytes(data: BufferSource): Uint8Array<ArrayBuffer> {
  let source: Uint8Array;
  if (ArrayBuffer.isView(data)) {
    source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    source = new Uint8Array(data);
  } else {
    throw new TypeError("crypto.subtle.digest: expected an ArrayBuffer or an ArrayBuffer view");
  }
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytes;
}

/** `crypto.subtle.digest` for SHA-256 only, backed by expo-crypto (the OS's SHA-256). */
async function digestSha256(
  algorithm: AlgorithmIdentifier,
  data: BufferSource,
): Promise<ArrayBuffer> {
  const name = typeof algorithm === "string" ? algorithm : algorithm?.name;
  if (typeof name !== "string" || name.toUpperCase() !== "SHA-256") {
    throw namedError("NotSupportedError", "crypto.subtle.digest: only SHA-256 is supported");
  }
  return digest(CryptoDigestAlgorithm.SHA256, toBytes(data));
}

/**
 * Gives supabase-js the SHA-256 it needs to send an S256 PKCE challenge
 * (ADR-0045).
 *
 * Hermes has no `crypto.subtle`. Without it, supabase-js sends the verifier
 * itself as a `plain` challenge, so anyone who sees the authorize request also
 * learns the verifier. This installs a `crypto.subtle` with `digest` only,
 * keeping the `crypto` members already there (such as the `getRandomValues`
 * from `installCryptoRandom`).
 *
 * - Leaves a runtime that already has `crypto.subtle` untouched.
 * - Installs nothing without `TextEncoder` and `btoa`. supabase-js checks for
 *   `TextEncoder` before hashing, but calls `btoa` on the S256 path without
 *   checking, so `subtle` without `btoa` would throw in the middle of a
 *   sign-in instead of falling back to `plain`.
 *
 * `subtle` has `digest` only. `supabase.auth.getClaims()` checks for
 * `crypto.subtle` and then calls `subtle.importKey` on an asymmetric JWT. Here
 * that throws a `TypeError`, which `getClaims()` rethrows (it returns only auth
 * errors as `{ error }`), instead of falling back to `getUser()`. Nothing calls
 * `getClaims()` on mobile today; add `importKey` and `verify` before anything
 * does.
 */
export function installCryptoDigest(): void {
  const scope = globalThis as CryptoScope;
  if (typeof scope.crypto?.subtle !== "undefined") return;
  if (typeof TextEncoder !== "function" || typeof btoa !== "function") return;
  scope.crypto = { ...scope.crypto, subtle: { digest: digestSha256 } };
}
