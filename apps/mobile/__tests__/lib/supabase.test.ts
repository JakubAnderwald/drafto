const mockCreateClient = jest.fn(() => ({ auth: {} }));
const mockInstallCryptoRandom = jest.fn();
const mockInstallCryptoDigest = jest.fn();

jest.mock("@/lib/crypto-random", () => ({
  installCryptoRandom: () => mockInstallCryptoRandom(),
}));

jest.mock("@/lib/crypto-digest", () => ({
  installCryptoDigest: () => mockInstallCryptoDigest(),
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...(args as [])),
}));

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon-key" },
    },
  },
}));

describe("supabase client", () => {
  beforeEach(() => {
    // Each test requires the module afresh, so each must see only its own calls.
    mockCreateClient.mockClear();
    mockInstallCryptoRandom.mockClear();
    mockInstallCryptoDigest.mockClear();
  });

  it("runs the PKCE flow, so deep links never carry session tokens (ADR-0045)", () => {
    // Required lazily: a static import would run createClient before `mockCreateClient` exists.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
      require("@/lib/supabase");
    });

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    // The CSPRNG must be in place before supabase-js generates any code verifier.
    expect(mockInstallCryptoRandom).toHaveBeenCalledTimes(1);
    expect(mockInstallCryptoRandom.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateClient.mock.invocationCallOrder[0],
    );
    // So must the SHA-256 digest, or supabase-js sends a `plain` challenge.
    expect(mockInstallCryptoDigest).toHaveBeenCalledTimes(1);
    expect(mockInstallCryptoDigest.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateClient.mock.invocationCallOrder[0],
    );
    const [url, key, options] = mockCreateClient.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { flowType?: string; persistSession?: boolean } },
    ];
    expect(url).toBe("https://example.supabase.co");
    expect(key).toBe("anon-key");
    expect(options.auth.flowType).toBe("pkce");
    expect(options.auth.persistSession).toBe(true);
  });

  it("puts each PKCE flow's id on its redirect, so a newer flow cannot spoil a pending one", () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
      require("@/lib/supabase");
    });

    const [, , options] = mockCreateClient.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { experimental?: { appendPkceFlowIdToRedirects?: boolean } } },
    ];
    // Experimental in auth-js: pkce-flow-ids.test.ts fails if a bump stops honouring it.
    expect(options.auth.experimental?.appendPkceFlowIdToRedirects).toBe(true);
  });
});
