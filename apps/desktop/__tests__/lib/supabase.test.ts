import AsyncStorage from "@react-native-async-storage/async-storage";

const mockCreateClient = jest.fn(() => ({ auth: {} }));
const mockInstalled = Promise.resolve();
const mockInstallCryptoRandom = jest.fn(() => mockInstalled);

jest.mock("@/lib/crypto-random", () => ({
  installCryptoRandom: () => mockInstallCryptoRandom(),
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...(args as [])),
}));

jest.mock("@/lib/config", () => ({
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon-key",
}));

describe("supabase client", () => {
  it("installs the CSPRNG before creating the PKCE client (ADR-0062)", () => {
    // Required lazily: a static import would run createClient before `mockCreateClient` exists.
    let client: { cryptoReady?: unknown } = {};
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
      client = require("@/lib/supabase");
    });

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    // supabase-js draws the code verifier from crypto.getRandomValues, so it must exist first.
    expect(mockInstallCryptoRandom).toHaveBeenCalledTimes(1);
    expect(mockInstallCryptoRandom.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateClient.mock.invocationCallOrder[0],
    );
    // `subtle` lands only when the install settles, so PKCE flow starts await this.
    expect(client.cryptoReady).toBe(mockInstalled);
    const [url, key, options] = mockCreateClient.mock.calls[0] as unknown as [
      string,
      string,
      {
        auth: { flowType?: string; storage?: unknown; detectSessionInUrl?: boolean };
        global: { headers: Record<string, string> };
      },
    ];
    expect(url).toBe("https://example.supabase.co");
    expect(key).toBe("anon-key");
    expect(options.auth.flowType).toBe("pkce");
    expect(options.auth.storage).toBe(AsyncStorage);
    expect(options.auth.detectSessionInUrl).toBe(false);
    expect(options.global.headers["x-drafto-client"]).toBe("desktop-macos");
  });
});
