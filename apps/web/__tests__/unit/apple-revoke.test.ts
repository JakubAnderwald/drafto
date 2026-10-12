/**
 * @vitest-environment node
 */
import crypto from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

const { APPLE_REVOKE_URL, APPLE_TOKEN_URL, revokeAppleSignIn } = await import("@/lib/apple/revoke");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY = {
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const APPLE_SUB = "000123.abcdef.0456";
const CODE = "c0de-from-apple";
const REFRESH_TOKEN = "r.refresh-token-secret";
const ACCESS_TOKEN = "a.access-token-secret";
const GRANT = { authorizationCode: CODE, clientId: "eu.drafto.mobile" };

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const idToken = (claims: Record<string, unknown>) =>
  `${encode({ alg: "RS256", kid: "apple" })}.${encode(claims)}.signature`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const tokenSuccess = (overrides: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: REFRESH_TOKEN,
    id_token: idToken({ iss: "https://appleid.apple.com", sub: APPLE_SUB }),
    ...overrides,
  });

const fetchMock = vi.fn<typeof fetch>();

function revoke(overrides: Partial<Parameters<typeof revokeAppleSignIn>[1]> = {}) {
  return revokeAppleSignIn(GRANT, {
    key: KEY,
    appleSubjects: [APPLE_SUB],
    userId: USER_ID,
    fetchImpl: fetchMock,
    ...overrides,
  });
}

function formOf(callIndex: number): URLSearchParams {
  const init = fetchMock.mock.calls[callIndex][1];
  return new URLSearchParams(String(init?.body));
}

/** Nothing secret may reach Sentry: no code, token or client secret. */
function expectNoSecretsReported(): void {
  const reported = JSON.stringify([
    captureExceptionMock.mock.calls,
    captureMessageMock.mock.calls,
    captureExceptionMock.mock.calls.map(([err]) => String(err)),
  ]);
  for (const secret of [CODE, REFRESH_TOKEN, ACCESS_TOKEN, KEY.privateKey]) {
    expect(reported).not.toContain(secret);
  }
  for (const call of fetchMock.mock.calls) {
    const clientSecret = new URLSearchParams(String(call[1]?.body)).get("client_secret");
    if (clientSecret) expect(reported).not.toContain(clientSecret);
  }
}

describe("revokeAppleSignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(tokenSuccess())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
  });

  describe("success", () => {
    it("exchanges the code for a refresh token, then revokes it", async () => {
      expect(await revoke()).toBe("revoked");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe(APPLE_TOKEN_URL);
      expect(tokenInit).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      expect(tokenInit?.signal).toBeInstanceOf(AbortSignal);
      const tokenForm = formOf(0);
      expect(tokenForm.get("client_id")).toBe("eu.drafto.mobile");
      expect(tokenForm.get("code")).toBe(CODE);
      expect(tokenForm.get("grant_type")).toBe("authorization_code");
      // Native codes are redeemed without a redirect_uri.
      expect(tokenForm.has("redirect_uri")).toBe(false);

      const [revokeUrl, revokeInit] = fetchMock.mock.calls[1];
      expect(revokeUrl).toBe(APPLE_REVOKE_URL);
      expect(revokeInit?.signal).toBeInstanceOf(AbortSignal);
      const revokeForm = formOf(1);
      expect(revokeForm.get("client_id")).toBe("eu.drafto.mobile");
      expect(revokeForm.get("token")).toBe(REFRESH_TOKEN);
      expect(revokeForm.get("token_type_hint")).toBe("refresh_token");
      expect(revokeForm.get("client_secret")).toBe(tokenForm.get("client_secret"));

      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(captureMessageMock).not.toHaveBeenCalled();
    });

    it("signs a short-lived ES256 client secret for the native client", async () => {
      const before = Math.floor(Date.now() / 1000);
      await revoke();

      const secret = formOf(0).get("client_secret") ?? "";
      const [header, claims, signature] = secret.split(".");
      expect(decode(header)).toEqual({ alg: "ES256", kid: KEY.keyId });
      const payload = decode(claims);
      expect(payload).toMatchObject({
        iss: KEY.teamId,
        aud: "https://appleid.apple.com",
        sub: "eu.drafto.mobile",
      });
      expect(payload.iat).toBeGreaterThanOrEqual(before);
      expect(payload.exp - payload.iat).toBe(300);
      const verified = crypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      );
      expect(verified).toBe(true);
    });

    it("revokes the access token when Apple issued no refresh token", async () => {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(tokenSuccess({ refresh_token: undefined }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      expect(await revoke()).toBe("revoked");
      expect(formOf(1).get("token")).toBe(ACCESS_TOKEN);
      expect(formOf(1).get("token_type_hint")).toBe("access_token");
    });

    it("accepts a code for any of the account's Apple identities", async () => {
      expect(await revoke({ appleSubjects: ["other-sub", APPLE_SUB] })).toBe("revoked");
    });
  });

  describe("skipped without calling Apple", () => {
    it("reports a warning when no Apple key is configured", async () => {
      expect(await revoke({ key: null })).toBe("not-configured");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(captureMessageMock).toHaveBeenCalledWith(
        expect.stringContaining("no Apple key is configured"),
        { level: "warning", extra: { where: "apple-revoke:not-configured", userId: USER_ID } },
      );
    });

    it("refuses a client it does not redeem codes for", async () => {
      const outcome = await revokeAppleSignIn(
        { ...GRANT, clientId: "eu.drafto.web.auth" },
        { key: KEY, appleSubjects: [APPLE_SUB], userId: USER_ID, fetchImpl: fetchMock },
      );

      expect(outcome).toBe("unsupported-client");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(captureMessageMock).toHaveBeenCalledWith(expect.any(String), {
        level: "warning",
        extra: {
          where: "apple-revoke:unsupported-client",
          userId: USER_ID,
          clientId: "eu.drafto.web.auth",
        },
      });
    });

    it("does not redeem a code for an account with no Apple identity", async () => {
      expect(await revoke({ appleSubjects: [] })).toBe("no-apple-identity");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(captureMessageMock).toHaveBeenCalledWith(expect.any(String), {
        level: "warning",
        extra: { where: "apple-revoke:no-apple-identity", userId: USER_ID },
      });
    });

    it("reports a key that cannot sign", async () => {
      expect(await revoke({ key: { ...KEY, privateKey: "not a pem" } })).toBe(
        "client-secret-failed",
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
        extra: { where: "apple-revoke:client-secret", userId: USER_ID },
      });
      expectNoSecretsReported();
    });
  });

  describe("token exchange failures", () => {
    it("reports Apple's error code and status, and never revokes", async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "invalid_grant" }));

      expect(await revoke()).toBe("token-exchange-failed");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(captureExceptionMock).toHaveBeenCalledWith(new Error("Apple answered HTTP 400"), {
        extra: {
          where: "apple-revoke:token",
          userId: USER_ID,
          clientId: "eu.drafto.mobile",
          status: 400,
          appleError: "invalid_grant",
        },
      });
      expectNoSecretsReported();
    });

    it("leaves out an error field that is not one of Apple's codes", async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: `leaked ${CODE}` }));

      await revoke();

      const extra = captureExceptionMock.mock.calls[0][1].extra;
      expect(extra).not.toHaveProperty("appleError");
      expectNoSecretsReported();
    });

    it("reports a non-JSON error response", async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));

      expect(await revoke()).toBe("token-exchange-failed");
      expect(captureExceptionMock.mock.calls[0][1].extra).toMatchObject({ status: 502 });
    });

    it("reports a network error", async () => {
      fetchMock.mockReset();
      const networkError = new TypeError("fetch failed");
      fetchMock.mockRejectedValueOnce(networkError);

      expect(await revoke()).toBe("token-exchange-failed");
      expect(captureExceptionMock).toHaveBeenCalledWith(networkError, {
        extra: { where: "apple-revoke:token", userId: USER_ID, clientId: "eu.drafto.mobile" },
      });
    });

    it("wraps a non-Error rejection", async () => {
      fetchMock.mockReset();
      fetchMock.mockRejectedValueOnce("socket hang up");

      expect(await revoke()).toBe("token-exchange-failed");
      expect(captureExceptionMock).toHaveBeenCalledWith(new Error("socket hang up"), {
        extra: expect.objectContaining({ where: "apple-revoke:token" }),
      });
    });

    it("gives up when Apple does not answer within the timeout", async () => {
      fetchMock.mockReset();
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );

      expect(await revoke({ timeoutMs: 20 })).toBe("token-exchange-failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(captureExceptionMock.mock.calls[0][0]).toMatchObject({ name: "TimeoutError" });
    });

    it.each([
      ["no tokens", { token_type: "Bearer" }],
      ["a body that is not an object", "just a string"],
    ])("reports a token response with %s", async (_label, body) => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(jsonResponse(200, body));

      expect(await revoke()).toBe("token-exchange-failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(captureExceptionMock).toHaveBeenCalledWith(
        new Error("Apple's token response carried no token to revoke"),
        { extra: { where: "apple-revoke:token", userId: USER_ID, clientId: "eu.drafto.mobile" } },
      );
    });
  });

  describe("Apple ID check", () => {
    it.each([
      ["a different Apple ID", { id_token: idToken({ sub: "someone-else" }) }],
      ["no ID token", { id_token: undefined }],
      ["an ID token with no payload", { id_token: "header-only" }],
      ["an ID token that is not JSON", { id_token: "a.bm90LWpzb24.c" }],
      ["an ID token with no subject", { id_token: idToken({ iss: "apple" }) }],
    ])("still revokes the token it obtained, and warns, for %s", async (_label, overrides) => {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(tokenSuccess(overrides))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      // Apple's sheet may just have authorized Drafto for the phone's Apple ID, so the flow
      // must not leave that authorization behind.
      expect(await revoke()).toBe("revoked-other-apple-id");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(formOf(1).get("token")).toBe(REFRESH_TOKEN);
      expect(captureMessageMock).toHaveBeenCalledWith(
        "Revoked Sign in with Apple for an Apple ID the account was not linked to",
        { level: "warning", extra: { where: "apple-revoke:subject-mismatch", userId: USER_ID } },
      );
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expectNoSecretsReported();
    });

    it("reports the revoke failure, not the mismatch, when revoking another Apple ID fails", async () => {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(tokenSuccess({ id_token: idToken({ sub: "someone-else" }) }))
        .mockResolvedValueOnce(jsonResponse(400, { error: "invalid_request" }));

      expect(await revoke()).toBe("revoke-failed");
      expect(captureMessageMock).not.toHaveBeenCalled();
      expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
        extra: expect.objectContaining({ where: "apple-revoke:revoke" }),
      });
    });
  });

  describe("revoke failures", () => {
    it("reports an HTTP error from /auth/revoke", async () => {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(tokenSuccess())
        .mockResolvedValueOnce(jsonResponse(400, { error: "invalid_client" }));

      expect(await revoke()).toBe("revoke-failed");
      expect(captureExceptionMock).toHaveBeenCalledWith(new Error("Apple answered HTTP 400"), {
        extra: {
          where: "apple-revoke:revoke",
          userId: USER_ID,
          clientId: "eu.drafto.mobile",
          status: 400,
          appleError: "invalid_client",
        },
      });
      expectNoSecretsReported();
    });

    it("reports a network error from /auth/revoke", async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(tokenSuccess()).mockRejectedValueOnce(new Error("reset"));

      expect(await revoke()).toBe("revoke-failed");
      expect(captureExceptionMock).toHaveBeenCalledWith(new Error("reset"), {
        extra: { where: "apple-revoke:revoke", userId: USER_ID, clientId: "eu.drafto.mobile" },
      });
    });
  });

  it("never throws, even on an unexpected error", async () => {
    fetchMock.mockReset();
    // A response without text() makes the reader itself throw.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    expect(await revoke()).toBe("revoke-failed");
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(TypeError), {
      extra: { where: "apple-revoke:unexpected", userId: USER_ID },
    });
  });
});
