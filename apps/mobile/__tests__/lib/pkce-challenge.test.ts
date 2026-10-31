/**
 * Runs auth-js's real PKCE code against the crypto that `supabase.ts` installs,
 * with expo-crypto faked by Node's WebCrypto. Proves the claim of ADR-0045's
 * update: on a runtime with no `crypto` (Hermes), the verifier comes from the
 * CSPRNG and the challenge is sent as S256.
 */
import { createClient } from "@supabase/supabase-js";
import {
  generatePKCEChallenge,
  generatePKCEVerifier,
} from "@supabase/auth-js/dist/main/lib/helpers";

import { installCryptoDigest } from "@/lib/crypto-digest";
import { installCryptoRandom } from "@/lib/crypto-random";

// Node's WebCrypto and btoa, kept before the tests remove them the way Hermes lacks them.
const nodeCrypto = globalThis.crypto;
const nodeBtoa = globalThis.btoa;

const mockGetRandomValues = jest.fn(<T extends ArrayBufferView<ArrayBuffer>>(array: T): T =>
  nodeCrypto.getRandomValues(array),
);
const mockDigest = jest.fn(
  async (_algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> =>
    nodeCrypto.subtle.digest("SHA-256", data),
);

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomValues: (array: ArrayBufferView<ArrayBuffer>) => mockGetRandomValues(array),
  digest: (algorithm: string, data: Uint8Array<ArrayBuffer>) => mockDigest(algorithm, data),
}));

const PLAIN_FALLBACK_WARNING = expect.stringContaining("WebCrypto API is not supported");

function setGlobal(name: "crypto" | "btoa", value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** The S256 challenge RFC 7636 defines: BASE64URL(SHA256(verifier)), unpadded. */
async function base64UrlSha256(text: string): Promise<string> {
  const hash = new Uint8Array(await nodeCrypto.subtle.digest("SHA-256", utf8(text)));
  return nodeBtoa(String.fromCharCode(...hash))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

type RecoverBody = { code_challenge?: string; code_challenge_method?: string };

/**
 * Requests a password reset the way `app/(auth)/forgot-password.tsx` does, with
 * the request answered locally, and returns the `/recover` body it sent and the
 * verifier it stored.
 */
async function requestPasswordReset() {
  const storage = memoryStorage();
  const requests: { url: string; body: RecoverBody }[] = [];
  const fetchStub = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as RecoverBody });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const client = createClient("https://example.supabase.co", "anon-key", {
    auth: {
      storage,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
    global: { fetch: fetchStub },
  });

  const { error } = await client.auth.resetPasswordForEmail("reset@example.com", {
    redirectTo: "drafto://reset-password",
  });
  expect(error).toBeNull();

  const recover = requests.find((request) => new URL(request.url).pathname === "/auth/v1/recover");
  if (!recover) throw new Error("resetPasswordForEmail sent no /recover request");

  // supabase-js mirrors the newest flow's verifier into this fixed key, with `/recovery` appended.
  const verifierKey = [...storage.items.keys()].find((key) =>
    key.endsWith("-auth-token-code-verifier"),
  );
  if (!verifierKey) throw new Error("no code verifier was stored");
  const stored = JSON.parse(storage.items.get(verifierKey) as string) as string;

  return { body: recover.body, verifier: stored.replace(/\/recovery$/, "") };
}

describe("PKCE challenge on mobile", () => {
  const originals = { crypto: globalThis.crypto as unknown, btoa: globalThis.btoa as unknown };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Hermes has no global crypto. Without this, Node's own WebCrypto would make the test pass.
    setGlobal("crypto", undefined);
    // supabase-js warns when it falls back to a plain challenge.
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    setGlobal("crypto", originals.crypto);
    setGlobal("btoa", originals.btoa);
    warn.mockRestore();
  });

  it("makes auth-js's generatePKCEChallenge return the base64url SHA-256 of the verifier", async () => {
    installCryptoRandom();
    installCryptoDigest();

    const verifier = generatePKCEVerifier();
    const challenge = await generatePKCEChallenge(verifier);

    expect(challenge).not.toBe(verifier);
    expect(challenge).toBe(await base64UrlSha256(verifier));
    expect(mockDigest).toHaveBeenCalledWith("SHA-256", utf8(verifier));
    expect(warn).not.toHaveBeenCalledWith(PLAIN_FALLBACK_WARNING);
  });

  it("matches RFC 7636's S256 example", async () => {
    installCryptoDigest();

    // RFC 7636, Appendix B.
    await expect(
      generatePKCEChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("sends an S256 challenge of a CSPRNG verifier with a password-reset request", async () => {
    installCryptoRandom();
    installCryptoDigest();

    const { body, verifier } = await requestPasswordReset();

    expect(body.code_challenge_method).toBe("s256");
    expect(body.code_challenge).toBe(await base64UrlSha256(verifier));
    // 56 random 32-bit words, hex-encoded by supabase-js.
    expect(verifier).toMatch(/^[0-9a-f]{112}$/);
    expect(mockGetRandomValues).toHaveBeenCalled();
    expect(mockDigest).toHaveBeenCalledWith("SHA-256", utf8(verifier));
    expect(warn).not.toHaveBeenCalledWith(PLAIN_FALLBACK_WARNING);
  });

  it("sent plain before the digest shim, as the dev flow_state rows showed", async () => {
    installCryptoRandom();

    const { body, verifier } = await requestPasswordReset();

    expect(body.code_challenge_method).toBe("plain");
    expect(body.code_challenge).toBe(verifier);
    expect(mockDigest).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(PLAIN_FALLBACK_WARNING);
  });

  it("still sends the reset request, with a plain challenge, on a runtime without btoa", async () => {
    // supabase-js calls btoa on the S256 path without checking for it.
    setGlobal("btoa", undefined);
    installCryptoRandom();
    installCryptoDigest();

    const { body, verifier } = await requestPasswordReset();

    expect(body.code_challenge_method).toBe("plain");
    expect(body.code_challenge).toBe(verifier);
    expect(verifier).toMatch(/^[0-9a-f]{112}$/);
    expect(mockGetRandomValues).toHaveBeenCalled();
  });
});
