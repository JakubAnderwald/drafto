import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The two OS association files under public/.well-known (ADR-0074).
 *
 * Both shipped with placeholders for months, so Android App Links and iOS Universal
 * Links never verified and Play Console flagged drafto.eu as unverified. These checks
 * stop a placeholder or a malformed value from coming back. They can't prove the
 * fingerprint is the right one — the Digital Asset Links API check in
 * docs/operations/builds-and-releases.md does that against the live file.
 */

const WELL_KNOWN = path.resolve(__dirname, "../../public/.well-known");
const PACKAGE_NAME = "eu.drafto.mobile";

function readWellKnown(name: string): string {
  return readFileSync(path.join(WELL_KNOWN, name), "utf8");
}

interface AssetLinkStatement {
  relation: string[];
  target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
}

interface AppleAppSiteAssociation {
  applinks: { details: Array<{ appIDs: string[]; components: Array<Record<string, string>> }> };
}

describe("assetlinks.json (Android App Links)", () => {
  const raw = readWellKnown("assetlinks.json");
  const statements = JSON.parse(raw) as AssetLinkStatement[];

  it("has no placeholder left", () => {
    expect(raw).not.toMatch(/REPLACE_WITH/);
  });

  it("delegates handle_all_urls to the Drafto Android app", () => {
    expect(statements).toHaveLength(1);
    const [statement] = statements;
    expect(statement.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(statement.target.namespace).toBe("android_app");
    expect(statement.target.package_name).toBe(PACKAGE_NAME);
  });

  it("lists only well-formed SHA-256 certificate fingerprints", () => {
    // Google rejects the whole file (ERROR_CODE_MALFORMED_CONTENT) on one bad entry.
    const fingerprints = statements[0].target.sha256_cert_fingerprints;
    expect(fingerprints.length).toBeGreaterThan(0);
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});

describe("apple-app-site-association (iOS Universal Links)", () => {
  const raw = readWellKnown("apple-app-site-association");
  const aasa = JSON.parse(raw) as AppleAppSiteAssociation;

  it("has no placeholder left", () => {
    expect(raw).not.toMatch(/REPLACE_WITH/);
  });

  it("names the Drafto iOS app by Team ID and bundle ID", () => {
    const appIDs = aasa.applinks.details.flatMap((detail) => detail.appIDs);
    expect(appIDs).toEqual([`4J2USPSG2U.${PACKAGE_NAME}`]);
  });

  it("claims only the note and notebook paths", () => {
    const paths = aasa.applinks.details.flatMap((detail) =>
      detail.components.map((component) => component["/"]),
    );
    expect(paths).toEqual(["/notebooks/*", "/notes/*"]);
  });
});
