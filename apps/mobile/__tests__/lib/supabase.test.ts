const mockCreateClient = jest.fn(() => ({ auth: {} }));

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
  it("runs the PKCE flow, so deep links never carry session tokens (ADR-0045)", () => {
    // Required lazily: a static import would run createClient before `mockCreateClient` exists.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
      require("@/lib/supabase");
    });

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
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
});
