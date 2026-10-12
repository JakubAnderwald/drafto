/**
 * @vitest-environment node
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requestAccountDeletion } from "@drafto/shared";

// The real route, body reader, key config and Apple client run together; only
// Supabase and the network are stubbed.
const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const mockEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  APP_URL: "https://drafto.eu",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_SIGN_IN_KEY_ID: "KEY1234567",
  APPLE_SIGN_IN_PRIVATE_KEY: "",
}));
mockEnv.APPLE_SIGN_IN_PRIVATE_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString()
  .replace(/\n/g, "\\n");
vi.mock("@/env", () => ({ env: mockEnv }));

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

const USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const APPLE_SUB = "000123.abcdef.0456";

const getUserMock = vi.fn();
const deleteUserMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { getUser: getUserMock, admin: { deleteUser: deleteUserMock } },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { is_admin: false }, error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        list: () => Promise.resolve({ data: [], error: null }),
        remove: () => Promise.resolve({ data: [], error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: vi.fn() } }),
}));

const { DELETE } = await import("@/app/api/account/route");

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const appleFetch = vi.fn<typeof fetch>();

/** Sends the request the iOS app sends, through the shared client, to the route. */
async function deleteFromIos(authorizationCode = "fresh-apple-code") {
  return requestAccountDeletion({
    baseUrl: "http://localhost:3000",
    accessToken: "supabase-access-token",
    appleRevocation: { authorizationCode, clientId: "eu.drafto.mobile" },
    fetchImpl: (input, init) => DELETE(new NextRequest(input, init)),
  });
}

describe("DELETE /api/account with a Sign in with Apple code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appleFetch.mockReset();
    vi.stubGlobal("fetch", appleFetch);
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: USER_ID,
          identities: [{ provider: "apple", id: APPLE_SUB, identity_data: { sub: APPLE_SUB } }],
        },
      },
      error: null,
    });
    deleteUserMock.mockResolvedValue({ data: { user: null }, error: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes the account, then exchanges the code and revokes the refresh token", async () => {
    appleFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "apple-access",
            refresh_token: "apple-refresh",
            id_token: `${encode({ alg: "RS256" })}.${encode({ sub: APPLE_SUB })}.sig`,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    expect(await deleteFromIos()).toEqual({ status: "ok" });

    expect(getUserMock).toHaveBeenCalledWith("supabase-access-token");
    expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
    expect(appleFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://appleid.apple.com/auth/token",
      "https://appleid.apple.com/auth/revoke",
    ]);
    expect(deleteUserMock.mock.invocationCallOrder[0]).toBeLessThan(
      appleFetch.mock.invocationCallOrder[0],
    );
    const tokenForm = new URLSearchParams(String(appleFetch.mock.calls[0][1]?.body));
    expect(tokenForm.get("code")).toBe("fresh-apple-code");
    // The escaped one-line key from the environment signed a three-part JWT.
    expect(tokenForm.get("client_secret")?.split(".")).toHaveLength(3);
    const revokeForm = new URLSearchParams(String(appleFetch.mock.calls[1][1]?.body));
    expect(revokeForm.get("token")).toBe("apple-refresh");
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("still reports the deletion as done when Apple rejects the code", async () => {
    appleFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    expect(await deleteFromIos("expired-code")).toEqual({ status: "ok" });

    expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
    expect(appleFetch).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      extra: expect.objectContaining({ where: "apple-revoke:token", appleError: "invalid_grant" }),
    });
    expect(JSON.stringify(captureExceptionMock.mock.calls)).not.toContain("expired-code");
  });

  it("still reports the deletion as done when Apple is unreachable", async () => {
    appleFetch.mockRejectedValue(new TypeError("fetch failed"));

    expect(await deleteFromIos()).toEqual({ status: "ok" });
    expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
  });
});
