import { describe, expect, it } from "vitest";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

function createTestEnv(overrides: Record<string, string | undefined> = {}) {
  const defaults = {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  };

  const runtimeEnv = { ...defaults, ...overrides };

  return createEnv({
    server: {},
    client: {
      NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
    },
    runtimeEnv: {
      NEXT_PUBLIC_SUPABASE_URL: runtimeEnv.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: runtimeEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    },
  });
}

describe("env validation", () => {
  it("accepts valid Supabase config", () => {
    const env = createTestEnv();
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://test.supabase.co");
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("test-anon-key");
  });

  it("rejects missing NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(() => createTestEnv({ NEXT_PUBLIC_SUPABASE_URL: undefined })).toThrow();
  });

  it("rejects invalid NEXT_PUBLIC_SUPABASE_URL (not a URL)", () => {
    expect(() => createTestEnv({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url" })).toThrow();
  });

  it("rejects missing NEXT_PUBLIC_SUPABASE_ANON_KEY", () => {
    expect(() => createTestEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined })).toThrow();
  });

  it("rejects empty NEXT_PUBLIC_SUPABASE_ANON_KEY", () => {
    expect(() => createTestEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "" })).toThrow();
  });

  it("skips validation when skipValidation is true", () => {
    const env = createEnv({
      server: {},
      client: {
        NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
        NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
      },
      runtimeEnv: {
        NEXT_PUBLIC_SUPABASE_URL: undefined,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
      },
      skipValidation: true,
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
  });
});
