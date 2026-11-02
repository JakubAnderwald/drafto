const mockGetRandomValues = jest.fn(<T>(array: T): T => array);

jest.mock("expo-crypto", () => ({
  getRandomValues: (array: unknown) => mockGetRandomValues(array),
}));

import { installCryptoRandom } from "@/lib/crypto-random";

type CryptoScope = { crypto?: Partial<Crypto> };

describe("installCryptoRandom", () => {
  const scope = globalThis as CryptoScope;
  let original: Partial<Crypto> | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    original = scope.crypto;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      value: original,
      configurable: true,
      writable: true,
    });
  });

  function withoutCrypto() {
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }

  it("installs crypto.getRandomValues backed by expo-crypto when the runtime has none", () => {
    // Hermes has no global crypto; supabase-js would otherwise use Math.random for the verifier.
    withoutCrypto();

    installCryptoRandom();

    const bytes = new Uint32Array(4);
    expect(scope.crypto?.getRandomValues?.(bytes)).toBe(bytes);
    expect(mockGetRandomValues).toHaveBeenCalledWith(bytes);
  });

  it("rejects arrays the CSPRNG cannot fill", () => {
    withoutCrypto();

    installCryptoRandom();

    expect(() => scope.crypto?.getRandomValues?.(new Float32Array(2))).toThrow(TypeError);
    expect(mockGetRandomValues).not.toHaveBeenCalled();
  });

  it("leaves an existing implementation alone", () => {
    const existing = jest.fn(<T>(array: T): T => array);
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: existing },
      configurable: true,
      writable: true,
    });

    installCryptoRandom();

    expect(scope.crypto?.getRandomValues).toBe(existing);
  });
});
