/**
 * @vitest-environment node
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { APPLE_NATIVE_CLIENT_ID } from "@drafto/shared";
import {
  APPLE_SERVICES_ID,
  MAX_LIFETIME_SECONDS,
  buildClientSecret,
} from "@/lib/apple/client-secret.mjs";

// The rotation script re-exports this signer; scripts/__tests__/apple-client-secret.test.mjs
// covers it from that side. These checks pin what the web API relies on.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("Apple client secret", () => {
  it("names the two Sign in with Apple clients", () => {
    expect(APPLE_NATIVE_CLIENT_ID).toBe("eu.drafto.mobile");
    expect(APPLE_SERVICES_ID).toBe("eu.drafto.web.auth");
  });

  it("signs a verifiable ES256 JWT with the claims Apple checks", () => {
    const secret = buildClientSecret({
      privateKey: pem,
      keyId: "KEY123",
      teamId: "TEAM456",
      clientId: APPLE_NATIVE_CLIENT_ID,
      issuedAt: 1_800_000_000,
      lifetimeSeconds: 300,
    });
    const [header, claims, signature] = secret.split(".");

    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(decode(claims)).toEqual({
      iss: "TEAM456",
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      aud: "https://appleid.apple.com",
      sub: APPLE_NATIVE_CLIENT_ID,
    });
    const raw = Buffer.from(signature, "base64url");
    expect(raw).toHaveLength(64);
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        raw,
      ),
    ).toBe(true);
  });

  it("rejects lifetimes Apple would refuse", () => {
    const build = (lifetimeSeconds: number) =>
      buildClientSecret({
        privateKey: pem,
        keyId: "KEY123",
        teamId: "TEAM456",
        clientId: APPLE_NATIVE_CLIENT_ID,
        lifetimeSeconds,
      });

    expect(() => build(MAX_LIFETIME_SECONDS + 1)).toThrow(/longer than/);
    expect(() => build(0)).toThrow(/positive whole number/);
  });
});
