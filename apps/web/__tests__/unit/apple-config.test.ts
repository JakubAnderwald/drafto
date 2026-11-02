import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User } from "@supabase/supabase-js";

const mockEnv: Record<string, string | undefined> = {};
vi.mock("@/env", () => ({ env: mockEnv }));

const { getAppleSignInKey } = await import("@/lib/apple/config");
const { appleSubjectsOf } = await import("@/lib/apple/identities");

const PEM = "-----BEGIN PRIVATE KEY-----\nMIGTAgEA\nAwEHBG0w\n-----END PRIVATE KEY-----";

describe("getAppleSignInKey", () => {
  beforeEach(() => {
    mockEnv.APPLE_TEAM_ID = "TEAM123456";
    mockEnv.APPLE_SIGN_IN_KEY_ID = "KEY1234567";
    mockEnv.APPLE_SIGN_IN_PRIVATE_KEY = PEM;
  });

  it("returns the key when all three variables are set", () => {
    expect(getAppleSignInKey()).toEqual({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: PEM,
    });
  });

  it.each(["APPLE_TEAM_ID", "APPLE_SIGN_IN_KEY_ID", "APPLE_SIGN_IN_PRIVATE_KEY"])(
    "returns null when %s is missing or blank",
    (name) => {
      mockEnv[name] = undefined;
      expect(getAppleSignInKey()).toBeNull();
      mockEnv[name] = "   ";
      expect(getAppleSignInKey()).toBeNull();
    },
  );

  it("turns literal \\n escapes into newlines and trims the values", () => {
    mockEnv.APPLE_TEAM_ID = " TEAM123456 ";
    mockEnv.APPLE_SIGN_IN_PRIVATE_KEY = `${PEM.replace(/\n/g, "\\n")}\\n`;

    expect(getAppleSignInKey()).toEqual({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: PEM,
    });
  });
});

describe("appleSubjectsOf", () => {
  const identity = (provider: string, id: string, sub?: unknown) => ({
    id,
    user_id: "user-1",
    identity_id: `${provider}-${id}`,
    provider,
    identity_data: sub === undefined ? {} : { sub },
  });

  it("collects the Apple sub from identity_data and the provider ID", () => {
    const user = {
      identities: [identity("apple", "apple-provider-id", "apple-sub")],
    } as Pick<User, "identities">;

    expect(appleSubjectsOf(user)).toEqual(["apple-sub", "apple-provider-id"]);
  });

  it("ignores other providers and de-duplicates", () => {
    const user = {
      identities: [
        identity("email", "user-1", "user-1"),
        identity("google", "google-id", "google-sub"),
        identity("apple", "apple-sub", "apple-sub"),
        identity("apple", "", 42),
      ],
    } as Pick<User, "identities">;

    expect(appleSubjectsOf(user)).toEqual(["apple-sub"]);
  });

  it("returns nothing for a user without identities", () => {
    expect(appleSubjectsOf({})).toEqual([]);
    expect(appleSubjectsOf({ identities: [] })).toEqual([]);
  });
});
