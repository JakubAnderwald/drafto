import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_LIFETIME_SECONDS, buildClientSecret, writeSecret } from "../apple-client-secret.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

function build(overrides = {}) {
  return buildClientSecret({
    privateKey: pem,
    keyId: "KEY123",
    teamId: "TEAM456",
    clientId: "eu.example.web",
    issuedAt: 1_800_000_000,
    lifetimeSeconds: 180 * 24 * 3600,
    ...overrides,
  });
}

describe("buildClientSecret", () => {
  it("carries the header and claims Apple checks", () => {
    const [header, claims] = build().split(".");
    assert.deepEqual(decode(header), { alg: "ES256", kid: "KEY123" });
    assert.deepEqual(decode(claims), {
      iss: "TEAM456",
      iat: 1_800_000_000,
      exp: 1_800_000_000 + 180 * 24 * 3600,
      aud: "https://appleid.apple.com",
      sub: "eu.example.web",
    });
  });

  it("signs with a raw 64-byte ES256 signature that the public key verifies", () => {
    const [header, claims, signature] = build().split(".");
    const raw = Buffer.from(signature, "base64url");
    // A DER signature would be ~70 bytes and fail JWS verification at Apple.
    assert.equal(raw.length, 64);
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      raw,
    );
    assert.equal(ok, true);
  });

  it("accepts Apple's maximum lifetime and rejects anything longer", () => {
    assert.doesNotThrow(() => build({ lifetimeSeconds: MAX_LIFETIME_SECONDS }));
    assert.throws(() => build({ lifetimeSeconds: MAX_LIFETIME_SECONDS + 1 }), /longer than/);
  });

  it("rejects a zero, negative or fractional lifetime", () => {
    for (const lifetimeSeconds of [0, -1, 1.5]) {
      assert.throws(() => build({ lifetimeSeconds }), /positive whole number/);
    }
  });
});

describe("writeSecret", () => {
  const dir = fs.mkdtemp(path.join(os.tmpdir(), "apple-secret-"));
  after(async () => fs.rm(await dir, { recursive: true, force: true }));

  it("writes an owner-only file and refuses to overwrite it", async () => {
    const out = path.join(await dir, "secret.jwt");
    await writeSecret(out, "a.b.c");
    assert.equal(await fs.readFile(out, "utf8"), "a.b.c");
    assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
    await assert.rejects(writeSecret(out, "x.y.z"), { code: "EEXIST" });
    assert.equal(await fs.readFile(out, "utf8"), "a.b.c");
  });
});
