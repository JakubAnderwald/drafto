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
// The paths must match apps/web/public/.well-known/apple-app-site-association,
// which apps/web/__tests__/unit/app-association-files.test.ts pins to the same
// two prefixes.
const APP_LINK_PATH_PREFIXES = ["/notebooks", "/notes"];

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

  it("claims the note and notebook paths the iOS association file claims", () => {
    const prefixes = appLinkData.map((entry) => entry.pathPrefix).sort();
    expect(prefixes).toEqual(APP_LINK_PATH_PREFIXES);
  });

  it("uses the package name assetlinks.json delegates to", () => {
    expect(assetLinks.map((statement) => statement.target.package_name)).toEqual([
      config.android?.package,
    ]);
  });
});
