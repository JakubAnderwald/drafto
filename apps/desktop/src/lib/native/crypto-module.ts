import { NativeModules } from "react-native";

/**
 * The in-project `DraftoCrypto` native module (`macos/Drafto-macOS/DraftoCrypto.mm`,
 * ADR-0062). Bytes cross the bridge as plain arrays of numbers (0–255); a typed
 * array would arrive natively as a dictionary.
 *
 * Pass exactly the declared arguments. The interop layer converts them before its
 * exception guard, so a `null` length can crash the app instead of throwing.
 */
export interface CryptoModule {
  /** `length` bytes from `SecRandomCopyBytes`, or `null` if it failed. Synchronous. */
  randomBytes(length: number): number[] | null;
  /** The 32-byte SHA-256 digest of `bytes`, from CommonCrypto. */
  sha256(bytes: number[]): Promise<number[]>;
}

/** The native module, or `null` where it isn't linked (Jest, CI). */
export function getCryptoModule(): CryptoModule | null {
  const candidate = (NativeModules as { DraftoCrypto?: Partial<CryptoModule> }).DraftoCrypto;
  if (typeof candidate?.randomBytes !== "function" || typeof candidate.sha256 !== "function") {
    return null;
  }
  return candidate as CryptoModule;
}
