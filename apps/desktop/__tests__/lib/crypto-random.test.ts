import { createHash, randomBytes } from "crypto";

const mockRandomBytes = jest.fn(
  (length: number): number[] | null => Array.from(randomBytes(length)) as number[],
);
const mockSha256 = jest.fn(
  async (bytes: number[]): Promise<number[]> =>
    Array.from(createHash("sha256").update(Uint8Array.from(bytes)).digest()) as number[],
);
let mockModule: { randomBytes: typeof mockRandomBytes; sha256: typeof mockSha256 } | null = null;

jest.mock("@/lib/native/crypto-module", () => ({
  getCryptoModule: () => mockModule,
}));

import { installCryptoRandom } from "@/lib/crypto-random";

type InstalledCrypto = {
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
  subtle?: { digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer> };
};

const scope = globalThis as { crypto?: InstalledCrypto };

function setGlobal(name: "crypto" | "btoa" | "TextEncoder", value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

/** Installs into a runtime with no `crypto` (Hermes), then forgets the install-time self-checks. */
async function install() {
  await installCryptoRandom();
  mockRandomBytes.mockClear();
  mockSha256.mockClear();
}

function getRandomValues() {
  const fn = scope.crypto?.getRandomValues;
  if (!fn) throw new Error("crypto.getRandomValues was not installed");
  return fn;
}

function digest() {
  const fn = scope.crypto?.subtle?.digest;
  if (!fn) throw new Error("crypto.subtle.digest was not installed");
  return fn;
}

/** A WebIDL-style crypto: methods on the prototype, so an object spread would lose them. */
class PrototypeCrypto {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    return array;
  }
}

describe("installCryptoRandom", () => {
  const originals = {
    crypto: globalThis.crypto as unknown,
    btoa: globalThis.btoa as unknown,
    TextEncoder: globalThis.TextEncoder as unknown,
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockModule = { randomBytes: mockRandomBytes, sha256: mockSha256 };
    // Hermes on react-native-macos has no global crypto.
    setGlobal("crypto", undefined);
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    setGlobal("crypto", originals.crypto);
    setGlobal("btoa", originals.btoa);
    setGlobal("TextEncoder", originals.TextEncoder);
    warn.mockRestore();
  });

  describe("installation", () => {
    it("installs getRandomValues and subtle.digest when the runtime has no crypto", async () => {
      await installCryptoRandom();

      expect(typeof scope.crypto?.getRandomValues).toBe("function");
      expect(typeof scope.crypto?.subtle?.digest).toBe("function");
      // The one-byte probe and the SHA-256("abc") self-test run before anything relies on them.
      expect(mockRandomBytes).toHaveBeenCalledWith(1);
      expect(mockSha256).toHaveBeenCalledWith([0x61, 0x62, 0x63]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("installs getRandomValues at once, before the SHA-256 self-test settles", () => {
      const pending = installCryptoRandom();

      expect(typeof scope.crypto?.getRandomValues).toBe("function");
      expect(scope.crypto?.subtle).toBeUndefined();
      return pending;
    });

    it("installs nothing, and does not throw, when the native module is absent (Jest, CI)", async () => {
      mockModule = null;

      await expect(installCryptoRandom()).resolves.toBeUndefined();

      expect(scope.crypto).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it("installs nothing when the module is linked but returns no bytes", async () => {
      mockRandomBytes.mockReturnValueOnce(null);

      await installCryptoRandom();

      expect(scope.crypto).toBeUndefined();
      expect(mockSha256).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("returned no random bytes"));
    });

    it("installs nothing when the probe call throws", async () => {
      mockRandomBytes.mockImplementationOnce(() => {
        throw new Error("bridge unavailable");
      });

      await expect(installCryptoRandom()).resolves.toBeUndefined();

      expect(scope.crypto).toBeUndefined();
    });

    it("installs nothing when the probe returns something other than one byte", async () => {
      mockRandomBytes.mockReturnValueOnce([256]);

      await installCryptoRandom();

      expect(scope.crypto).toBeUndefined();
    });

    it.each([
      ["rejects", () => mockSha256.mockRejectedValueOnce(new Error("E_INVALID_BYTES"))],
      [
        "throws synchronously",
        () =>
          mockSha256.mockImplementationOnce(() => {
            throw new Error("bridge unavailable");
          }),
      ],
      ["returns the wrong digest", () => mockSha256.mockResolvedValueOnce(new Array(32).fill(0))],
      ["returns too few bytes", () => mockSha256.mockResolvedValueOnce([1, 2, 3])],
    ])(
      "keeps getRandomValues but skips subtle when the SHA-256 self-test %s",
      async (_label, breakSha256) => {
        breakSha256();

        await installCryptoRandom();

        // A broken digest would otherwise fail every sign-in: supabase-js stops falling
        // back to a plain challenge as soon as crypto.subtle exists.
        expect(typeof scope.crypto?.getRandomValues).toBe("function");
        expect(scope.crypto?.subtle).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("SHA-256 self-test"));
      },
    );

    it("leaves a complete existing implementation alone", async () => {
      const existing = { getRandomValues: jest.fn(), subtle: { digest: jest.fn() } };
      setGlobal("crypto", existing);

      await installCryptoRandom();

      expect(scope.crypto).toBe(existing);
      expect(mockRandomBytes).not.toHaveBeenCalled();
    });

    it("keeps an existing getRandomValues and adds only the missing subtle", async () => {
      const existingRandom = jest.fn();
      setGlobal("crypto", { getRandomValues: existingRandom });

      await installCryptoRandom();

      expect(scope.crypto?.getRandomValues).toBe(existingRandom);
      expect(typeof scope.crypto?.subtle?.digest).toBe("function");
    });

    it("keeps an existing subtle and adds only the missing getRandomValues", async () => {
      const existingSubtle = { digest: jest.fn() };
      setGlobal("crypto", { subtle: existingSubtle });

      await installCryptoRandom();

      expect(scope.crypto?.subtle).toBe(existingSubtle);
      expect(typeof scope.crypto?.getRandomValues).toBe("function");
    });

    it("extends a prototype-based crypto in place, so its own methods survive", async () => {
      const existing = new PrototypeCrypto();
      setGlobal("crypto", existing);

      await installCryptoRandom();

      expect(scope.crypto).toBe(existing);
      expect(scope.crypto?.getRandomValues).toBe(PrototypeCrypto.prototype.getRandomValues);
      expect(typeof scope.crypto?.subtle?.digest).toBe("function");
    });

    it("keeps a non-enumerable getRandomValues", async () => {
      const existingRandom = jest.fn();
      const existing = {};
      Object.defineProperty(existing, "getRandomValues", { value: existingRandom });
      setGlobal("crypto", existing);

      await installCryptoRandom();

      expect(scope.crypto?.getRandomValues).toBe(existingRandom);
      expect(typeof scope.crypto?.subtle?.digest).toBe("function");
    });

    it("leaves a frozen crypto as is, without throwing", async () => {
      const existing = Object.freeze({ getRandomValues: jest.fn() });
      setGlobal("crypto", existing);

      await expect(installCryptoRandom()).resolves.toBeUndefined();

      expect(scope.crypto).toBe(existing);
      expect(scope.crypto?.subtle).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not add crypto.subtle"));
    });

    it("installs nothing more when getRandomValues can't be added", async () => {
      const existing = Object.freeze({});
      setGlobal("crypto", existing);

      await installCryptoRandom();

      expect(scope.crypto).toBe(existing);
      expect(mockSha256).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not add crypto.getRandomValues"),
      );
    });

    it("keeps a subtle that appeared while the self-test ran", async () => {
      const lateSubtle = { digest: jest.fn() };
      mockSha256.mockImplementationOnce(async (bytes: number[]) => {
        Object.defineProperty(scope.crypto, "subtle", { value: lateSubtle, configurable: true });
        return Array.from(createHash("sha256").update(Uint8Array.from(bytes)).digest()) as number[];
      });

      await installCryptoRandom();

      expect(scope.crypto?.subtle).toBe(lateSubtle);
    });

    it("skips subtle without btoa, which supabase-js calls unguarded on the S256 path", async () => {
      setGlobal("btoa", undefined);

      await installCryptoRandom();

      expect(typeof scope.crypto?.getRandomValues).toBe("function");
      expect(scope.crypto?.subtle).toBeUndefined();
      expect(mockSha256).not.toHaveBeenCalled();
    });

    it("skips subtle without TextEncoder", async () => {
      setGlobal("TextEncoder", undefined);

      await installCryptoRandom();

      expect(typeof scope.crypto?.getRandomValues).toBe("function");
      expect(scope.crypto?.subtle).toBeUndefined();
    });

    it("does nothing when only subtle is missing and it cannot be used", async () => {
      const existing = { getRandomValues: jest.fn() };
      setGlobal("crypto", existing);
      setGlobal("btoa", undefined);

      await installCryptoRandom();

      expect(scope.crypto).toBe(existing);
      expect(mockRandomBytes).not.toHaveBeenCalled();
    });

    it("is idempotent", async () => {
      await installCryptoRandom();
      const first = { ...scope.crypto };
      mockRandomBytes.mockClear();

      await installCryptoRandom();

      expect(scope.crypto?.getRandomValues).toBe(first.getRandomValues);
      expect(scope.crypto?.subtle).toBe(first.subtle);
      expect(mockRandomBytes).not.toHaveBeenCalled();
    });
  });

  describe("crypto.getRandomValues", () => {
    it("fills a Uint8Array with the native bytes and returns the same array", async () => {
      await install();
      mockRandomBytes.mockReturnValueOnce([1, 2, 3, 250]);
      const array = new Uint8Array(4);

      expect(getRandomValues()(array)).toBe(array);

      expect(mockRandomBytes).toHaveBeenCalledWith(4);
      expect(Array.from(array)).toEqual([1, 2, 3, 250]);
    });

    it("asks for byteLength bytes for wider arrays, as supabase-js's Uint32Array(56) verifier does", async () => {
      await install();
      const array = new Uint32Array(56);

      getRandomValues()(array);

      expect(mockRandomBytes).toHaveBeenCalledWith(224);
      expect(array.some((word) => word !== 0)).toBe(true);
    });

    it("fills only the view's own bytes when it starts at an offset", async () => {
      await install();
      mockRandomBytes.mockReturnValueOnce([1, 2, 3, 4, 5, 6, 7, 8]);
      const buffer = new ArrayBuffer(16);
      const view = new Uint32Array(buffer, 4, 2);

      expect(getRandomValues()(view)).toBe(view);

      expect(Array.from(new Uint8Array(buffer))).toEqual([
        0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0,
      ]);
    });

    it("accepts every integer typed array", async () => {
      await install();
      for (const array of [
        new Int8Array(2),
        new Uint8ClampedArray(2),
        new Int16Array(2),
        new Uint16Array(2),
        new Int32Array(2),
      ]) {
        expect(getRandomValues()(array)).toBe(array);
      }
    });

    it.each([
      ["a Float32Array", new Float32Array(2)],
      ["a Float64Array", new Float64Array(2)],
      ["a DataView", new DataView(new ArrayBuffer(4))],
      ["null", null],
    ])("rejects %s with a TypeError and never calls the native module", async (_label, value) => {
      await install();

      expect(() => getRandomValues()(value as ArrayBufferView | null)).toThrow(TypeError);

      expect(mockRandomBytes).not.toHaveBeenCalled();
    });

    it("rejects a plain array", async () => {
      await install();

      expect(() => getRandomValues()([1, 2] as unknown as Uint8Array)).toThrow(TypeError);
    });

    it("enforces the 65536-byte quota", async () => {
      await install();

      expect(getRandomValues()(new Uint8Array(65536))).toHaveLength(65536);
      expect(() => getRandomValues()(new Uint8Array(65537))).toThrow(
        expect.objectContaining({ name: "QuotaExceededError" }),
      );
      expect(mockRandomBytes).toHaveBeenCalledTimes(1);
    });

    it("returns an empty array without calling the native module", async () => {
      await install();
      const empty = new Uint8Array(0);

      expect(getRandomValues()(empty)).toBe(empty);

      expect(mockRandomBytes).not.toHaveBeenCalled();
    });

    it.each([
      ["null", null],
      ["too few bytes", [1, 2, 3]],
      ["too many bytes", [1, 2, 3, 4, 5]],
      ["a value above 255", [1, 2, 3, 256]],
      ["a non-integer", [1, 2, 3, 0.5]],
    ])(
      "throws on %s from the native module and leaves the array untouched",
      async (_label, result) => {
        await install();
        mockRandomBytes.mockReturnValueOnce(result);
        const array = new Uint8Array(4).fill(0xaa);

        expect(() => getRandomValues()(array)).toThrow("the system random source failed");

        // Never zero-filled, never partially filled: the caller gets an error, not weak bytes.
        expect(Array.from(array)).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
      },
    );
  });

  describe("crypto.subtle.digest", () => {
    const text = new TextEncoder().encode("drafto pkce verifier");

    it("matches Node's SHA-256 for a Uint8Array", async () => {
      await install();

      const hash = await digest()("SHA-256", Uint8Array.from(text));

      expect(hash).toBeInstanceOf(ArrayBuffer);
      expect(hex(hash)).toBe(sha256Hex(text));
      expect(mockSha256).toHaveBeenCalledWith(Array.from(text));
    });

    it("hashes TextEncoder output, which is what supabase-js passes", async () => {
      await install();

      expect(hex(await digest()("SHA-256", text))).toBe(sha256Hex(text));
    });

    it("hashes an ArrayBuffer", async () => {
      await install();
      const buffer = Uint8Array.from(text).buffer;

      expect(hex(await digest()("SHA-256", buffer))).toBe(sha256Hex(text));
    });

    it("hashes only the view's own bytes when it starts at an offset", async () => {
      await install();
      const buffer = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer;

      const hash = await digest()("SHA-256", new DataView(buffer, 2, 3));

      expect(hex(hash)).toBe(sha256Hex(new Uint8Array([1, 2, 3])));
    });

    it("accepts the algorithm as an object, in any case", async () => {
      await install();

      expect(hex(await digest()({ name: "sha-256" }, text))).toBe(sha256Hex(text));
    });

    it.each(["SHA-1", "SHA-512", ""])("rejects %j as not supported", async (algorithm) => {
      await install();

      await expect(digest()(algorithm, text)).rejects.toMatchObject({ name: "NotSupportedError" });
      expect(mockSha256).not.toHaveBeenCalled();
    });

    it("rejects data that is not a buffer", async () => {
      await install();

      await expect(digest()("SHA-256", "text" as unknown as BufferSource)).rejects.toThrow(
        TypeError,
      );
    });

    it("rejects a malformed native digest", async () => {
      await install();
      mockSha256.mockResolvedValueOnce([1, 2, 3]);

      await expect(digest()("SHA-256", text)).rejects.toThrow("the system SHA-256 failed");
    });

    it("passes a native rejection through", async () => {
      await install();
      mockSha256.mockRejectedValueOnce(new Error("E_INVALID_BYTES"));

      await expect(digest()("SHA-256", text)).rejects.toThrow("E_INVALID_BYTES");
    });
  });
});
