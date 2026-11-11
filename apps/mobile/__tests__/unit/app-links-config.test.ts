import type { ConfigContext, ExpoConfig } from "expo/config";

import appConfig from "../../app.config";
import assetLinks from "../../../web/public/.well-known/assetlinks.json";

// App Links (Android) and Universal Links (iOS) verify only on the apex host
// (ADR-0074). www.drafto.eu is a Vercel redirect domain, and neither Google's
// Digital Asset Links verifier nor Apple's CDN follows a redirect to the
// association file — so a www host can never verify, and on Android < 12 one
// unverifiable host fails the whole autoVerify filter. Play Console reported it
// as an unverified domain with two broken web links.
//
// The Android paths must match apps/web/public/.well-known/apple-app-site-association,
// so both platforms claim the same URLs. That file has no .json extension, so it
// can't be imported. It's read with Node's fs through jest, because the mobile
// tsconfig has no Node types. apps/mobile/turbo.json adds the file to this
// package's test inputs, so editing it invalidates the cached result.
interface ReadFs {
  readFileSync(path: string, encoding: "utf8"): string;
}

function readIosAssociationFile(): {
  applinks: { details: { components: Record<string, string>[] }[] };
} {
  const testPath = expect.getState().testPath ?? "";
  const file = testPath.replace(
    /apps\/mobile\/__tests__\/.*$/,
    "apps/web/public/.well-known/apple-app-site-association",
  );
  return JSON.parse(jest.requireActual<ReadFs>("fs").readFileSync(file, "utf8"));
}

const config: ExpoConfig = appConfig({
  config: {},
  projectRoot: "apps/mobile",
  staticConfigPath: null,
  packageJsonPath: null,
} satisfies ConfigContext);

const intentFilters = config.android?.intentFilters ?? [];
const appLinkFilters = intentFilters.filter((filter) => filter.autoVerify === true);
const appLinkData = appLinkFilters.flatMap((filter) =>
  Array.isArray(filter.data) ? filter.data : filter.data ? [filter.data] : [],
);

describe("app.config.ts App Links / Universal Links", () => {
  it("declares one verified https filter on the apex host only", () => {
    expect(appLinkFilters).toHaveLength(1);
    expect(appLinkData.length).toBeGreaterThan(0);
    for (const entry of appLinkData) {
      expect(entry.scheme).toBe("https");
      expect(entry.host).toBe("drafto.eu");
    }
  });

  it("associates iOS with the apex host only", () => {
    expect(config.ios?.associatedDomains).toEqual(["applinks:drafto.eu"]);
  });

  it("claims exactly the paths the iOS association file claims", () => {
    // iOS `/notes/*` ↔ Android pathPrefix `/notes/`.
    const iosPrefixes = readIosAssociationFile()
      .applinks.details.flatMap((detail) => detail.components.map((component) => component["/"]))
      .map((pattern) => pattern.replace(/\*$/, ""));
    const androidPrefixes = appLinkData.map((entry) => entry.pathPrefix);

    expect(iosPrefixes.length).toBeGreaterThan(0);
    expect([...androidPrefixes].sort()).toEqual([...iosPrefixes].sort());
  });

  it("uses the package name assetlinks.json delegates to", () => {
    expect(assetLinks.map((statement) => statement.target.package_name)).toEqual([
      config.android?.package,
    ]);
  });
});
