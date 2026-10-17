import { describe, expect, it } from "vitest";
import { DEV_SUPABASE_REF, isTestSignInEnabled } from "@/lib/auth/test-sign-in";

const DEV_URL = `https://${DEV_SUPABASE_REF}.supabase.co`;

describe("isTestSignInEnabled", () => {
  it("names the dev Supabase project", () => {
    expect(DEV_SUPABASE_REF).toBe("huhzactreblzcogqkbsd");
  });

  it("is on for a preview deployment backed by the dev project", () => {
    expect(isTestSignInEnabled({ vercelEnv: "preview", supabaseUrl: DEV_URL })).toBe(true);
  });

  it.each([
    ["a production deployment, even with the dev URL", "production", DEV_URL],
    ["Vercel's development environment", "development", DEV_URL],
    ["a local server with no VERCEL_ENV", undefined, DEV_URL],
    ["an unknown VERCEL_ENV", "staging", DEV_URL],
    [
      "a preview pointed at the prod project",
      "preview",
      "https://tbmjbxxseonkciqovnpl.supabase.co",
    ],
    ["a preview pointed at another project", "preview", "https://other.supabase.co"],
    ["a preview with a malformed URL", "preview", "not a url"],
    ["a preview with an empty URL", "preview", ""],
    [
      "a lookalike host that starts with the dev host",
      "preview",
      `https://${DEV_SUPABASE_REF}.supabase.co.evil.example`,
    ],
    [
      "a lookalike host that ends with the dev host",
      "preview",
      `https://evil.example/${DEV_SUPABASE_REF}.supabase.co`,
    ],
  ])("is off for %s", (_case, vercelEnv, supabaseUrl) => {
    expect(isTestSignInEnabled({ vercelEnv, supabaseUrl })).toBe(false);
  });
});
