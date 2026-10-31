import { installCryptoDigest } from "@/lib/crypto-digest";

// Node's WebCrypto, kept before each test removes `globalThis.crypto` (Hermes has none).
const nodeCrypto = globalThis.crypto;

const mockDigest = jest.fn(
  async (_algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> =>
    nodeCrypto.subtle.digest("SHA-256", data),
);

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: (algorithm: string, data: Uint8Array<ArrayBuffer>) => mockDigest(algorithm, data),
}));

type InstalledCrypto = {
  getRandomValues?: Crypto["getRandomValues"];
  subtle?: Pick<SubtleCrypto, "digest">;
};

/** SHA-256("abc"), the FIPS 180-2 test vector. */
const ABC = new TextEncoder().encode("abc");
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function setGlobal(name: "crypto" | "btoa" | "TextEncoder", value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function installedCrypto(): InstalledCrypto | undefined {
  return (globalThis as { crypto?: InstalledCrypto }).crypto;
}

/** The installed `digest`, failing the test if none was installed. */
function installedDigest(): SubtleCrypto["digest"] {
  const digest = installedCrypto()?.subtle?.digest;
  if (!digest) throw new Error("crypto.subtle.digest was not installed");
  return digest;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("installCryptoDigest", () => {
  const originals = {
    crypto: globalThis.crypto as unknown,
    btoa: globalThis.btoa as unknown,
    TextEncoder: globalThis.TextEncoder as unknown,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Jest runs on Node, which has a real crypto.subtle; Hermes has none.
    setGlobal("crypto", undefined);
  });

  afterEach(() => {
    setGlobal("crypto", originals.crypto);
    setGlobal("btoa", originals.btoa);
    setGlobal("TextEncoder", originals.TextEncoder);
  });

  it("installs a SHA-256 crypto.subtle.digest backed by expo-crypto when the runtime has no crypto", async () => {
    installCryptoDigest();

    const hash = await installedDigest()("SHA-256", ABC);

    expect(hex(hash)).toBe(ABC_SHA256);
    expect(mockDigest).toHaveBeenCalledTimes(1);
    expect(mockDigest).toHaveBeenCalledWith("SHA-256", ABC);
  });

  it("keeps the getRandomValues already installed on crypto", () => {
    const getRandomValues = jest.fn(<T>(array: T): T => array);
    const existing = { getRandomValues };
    setGlobal("crypto", existing);

    installCryptoDigest();

    expect(installedCrypto()).toBe(existing);
    expect(installedCrypto()?.getRandomValues).toBe(getRandomValues);
    expect(typeof installedCrypto()?.subtle?.digest).toBe("function");
  });

  it("adds subtle to a host crypto in place, keeping the getRandomValues it inherits", () => {
    const getRandomValues = jest.fn(<T>(array: T): T => array);
    // A host `Crypto` keeps its methods on the prototype, which a spread copy drops.
    const host: object = Object.create({ getRandomValues });
    setGlobal("crypto", host);

    installCryptoDigest();

    expect(installedCrypto()).toBe(host);
    expect(installedCrypto()?.getRandomValues).toBe(getRandomValues);
    expect(typeof installedCrypto()?.subtle?.digest).toBe("function");
  });

  it("installs nothing on a crypto that can't take a new property", () => {
    const frozen = Object.freeze({ getRandomValues: jest.fn(<T>(array: T): T => array) });
    setGlobal("crypto", frozen);

    expect(() => installCryptoDigest()).not.toThrow();

    expect(installedCrypto()).toBe(frozen);
    expect(installedCrypto()?.subtle).toBeUndefined();
  });

  it("hashes an ArrayBuffer, handing expo-crypto a typed array", async () => {
    installCryptoDigest();

    const hash = await installedDigest()("SHA-256", ABC.slice().buffer);

    expect(hex(hash)).toBe(ABC_SHA256);
    // The native digest takes a typed array only.
    expect(mockDigest.mock.calls[0][1]).toBeInstanceOf(Uint8Array);
  });

  it("hashes only the bytes a view covers, as a copy at offset 0", async () => {
    installCryptoDigest();
    const padded = new Uint8Array([0xff, ...ABC, 0xff]);

    const fromView = await installedDigest()("SHA-256", padded.subarray(1, 1 + ABC.length));
    const fromDataView = await installedDigest()(
      "SHA-256",
      new DataView(padded.buffer, 1, ABC.length),
    );

    expect(hex(fromView)).toBe(ABC_SHA256);
    expect(hex(fromDataView)).toBe(ABC_SHA256);
    const passed = mockDigest.mock.calls[0][1];
    expect(passed.byteOffset).toBe(0);
    expect(passed.buffer.byteLength).toBe(ABC.length);
  });

  it("accepts the algorithm as an object, in any case", async () => {
    installCryptoDigest();

    const hash = await installedDigest()({ name: "sha-256" }, ABC);

    expect(hex(hash)).toBe(ABC_SHA256);
  });

  it("rejects any other algorithm without calling expo-crypto", async () => {
    installCryptoDigest();

    await expect(installedDigest()("SHA-1", ABC)).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    await expect(installedDigest()({ name: "SHA-512" }, ABC)).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    expect(mockDigest).not.toHaveBeenCalled();
  });

  it("rejects data that is not an ArrayBuffer or a view", async () => {
    installCryptoDigest();

    await expect(
      installedDigest()("SHA-256", "not bytes" as unknown as BufferSource),
    ).rejects.toThrow(TypeError);
    expect(mockDigest).not.toHaveBeenCalled();
  });

  it("passes on a failure from expo-crypto", async () => {
    mockDigest.mockRejectedValueOnce(new Error("native digest failed"));
    installCryptoDigest();

    await expect(installedDigest()("SHA-256", ABC)).rejects.toThrow("native digest failed");
  });

  it("leaves an existing crypto.subtle alone", () => {
    const subtle = { digest: jest.fn() };
    setGlobal("crypto", { subtle });

    installCryptoDigest();

    expect(installedCrypto()?.subtle).toBe(subtle);
  });

  it.each(["btoa", "TextEncoder"] as const)(
    "installs nothing without %s, so supabase-js falls back to plain instead of throwing",
    (missing) => {
      const existing = { getRandomValues: jest.fn(<T>(array: T): T => array) };
      setGlobal("crypto", existing);
      setGlobal(missing, undefined);

      installCryptoDigest();

      expect(installedCrypto()).toBe(existing);
      expect(installedCrypto()?.subtle).toBeUndefined();
    },
  );
});
