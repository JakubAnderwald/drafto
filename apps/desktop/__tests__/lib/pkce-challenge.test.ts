/**
 * Runs the real supabase-js PKCE start (signInWithOAuth with
 * skipBrowserRedirect, which makes no network call) against the installed
 * crypto, with the DraftoCrypto native module faked on NativeModules by Node's
 * crypto. Proves the end-to-end claim of ADR-0062: verifier from the native
 * CSPRNG, challenge sent as S256.
 */
import { createHash, randomBytes } from "crypto";
import { NativeModules } from "react-native";
import { createClient } from "@supabase/supabase-js";

import { installCryptoRandom } from "@/lib/crypto-random";

const nativeRandomBytes = jest.fn(
  (length: number): number[] | null => Array.from(randomBytes(length)) as number[],
);
const nativeSha256 = jest.fn(
  async (bytes: number[]): Promise<number[]> =>
    Array.from(createHash("sha256").update(Uint8Array.from(bytes)).digest()) as number[],
);

const nativeModules = NativeModules as { DraftoCrypto?: unknown };

function setGlobal(name: "crypto" | "btoa", value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: async (key: string) => {
      items.delete(key);
    },
  };
}

/** Starts a Google sign-in the way `src/lib/oauth.ts` does, and returns what it sent and stored. */
async function startGoogleSignIn() {
  const storage = memoryStorage();
  const client = createClient("https://example.supabase.co", "anon-key", {
    auth: {
      storage,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });

  const { data, error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: "https://drafto.eu/auth/desktop/callback", skipBrowserRedirect: true },
  });
  expect(error).toBeNull();
  if (!data.url) throw new Error("signInWithOAuth returned no URL");

  // supabase-js mirrors the newest flow's verifier into this fixed key on every version we ship.
  const verifierKey = [...storage.items.keys()].find((key) =>
    key.endsWith("-auth-token-code-verifier"),
  );
  if (!verifierKey) throw new Error("no code verifier was stored");
  const verifier = JSON.parse(storage.items.get(verifierKey) as string) as string;

  return { params: new URL(data.url).searchParams, verifier };
}

function base64UrlSha256(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

describe("PKCE challenge on desktop", () => {
  const originals = { crypto: globalThis.crypto as unknown, btoa: globalThis.btoa as unknown };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Hermes on react-native-macos has no global crypto.
    setGlobal("crypto", undefined);
    nativeModules.DraftoCrypto = { randomBytes: nativeRandomBytes, sha256: nativeSha256 };
    // supabase-js warns when it falls back to a plain challenge.
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete nativeModules.DraftoCrypto;
    setGlobal("crypto", originals.crypto);
    setGlobal("btoa", originals.btoa);
    warn.mockRestore();
  });

  it("sends an S256 challenge of a verifier drawn from the native CSPRNG", async () => {
    await installCryptoRandom();

    const { params, verifier } = await startGoogleSignIn();

    expect(params.get("code_challenge_method")).toBe("s256");
    expect(params.get("code_challenge")).toBe(base64UrlSha256(verifier));
    // 56 random 32-bit words, hex-encoded by supabase-js.
    expect(verifier).toMatch(/^[0-9a-f]{112}$/);
    expect(nativeRandomBytes).toHaveBeenCalledWith(224);
    expect(nativeSha256).toHaveBeenCalledWith(Array.from(Buffer.from(verifier)));
  });

  it("still draws the verifier from the CSPRNG when only btoa is missing, with a plain challenge", async () => {
    setGlobal("btoa", undefined);
    await installCryptoRandom();

    const { params, verifier } = await startGoogleSignIn();

    expect(params.get("code_challenge_method")).toBe("plain");
    expect(params.get("code_challenge")).toBe(verifier);
    expect(verifier).toMatch(/^[0-9a-f]{112}$/);
    expect(nativeRandomBytes).toHaveBeenCalledWith(224);
  });

  it("still starts sign-in, with a CSPRNG verifier and a plain challenge, when the native SHA-256 is broken", async () => {
    // The install-time self-test is the only call: without `subtle`, supabase-js never hashes.
    nativeSha256.mockRejectedValueOnce(new Error("E_INVALID_BYTES"));
    await installCryptoRandom();

    const { params, verifier } = await startGoogleSignIn();

    expect(params.get("code_challenge_method")).toBe("plain");
    expect(params.get("code_challenge")).toBe(verifier);
    expect(verifier).toMatch(/^[0-9a-f]{112}$/);
    expect(nativeSha256).toHaveBeenCalledTimes(1);
  });

  it("falls back to supabase-js's own behaviour, and sign-in still starts, without the module", async () => {
    delete nativeModules.DraftoCrypto;
    await installCryptoRandom();

    const { params, verifier } = await startGoogleSignIn();

    expect(globalThis.crypto).toBeUndefined();
    expect(params.get("code_challenge_method")).toBe("plain");
    expect(params.get("code_challenge")).toBe(verifier);
    expect(nativeRandomBytes).not.toHaveBeenCalled();
  });

  it("treats a partly linked module as absent", async () => {
    nativeModules.DraftoCrypto = { randomBytes: nativeRandomBytes };

    await installCryptoRandom();

    expect(globalThis.crypto).toBeUndefined();
    expect(nativeRandomBytes).not.toHaveBeenCalled();
  });
});
