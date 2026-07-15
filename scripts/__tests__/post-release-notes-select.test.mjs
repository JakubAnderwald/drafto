import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBuilds,
  parseArgs,
  selectTestFlightBuild,
} from "../../apps/mobile/scripts/post-release-notes.mjs";

// Newest-builds fixture (the `sort=-uploadedDate` query): macOS (desktop) and iOS
// builds coexist under ONE shared App Store Connect app (eu.drafto.mobile). This
// is the exact shape the bug hinged on — a macOS build sorted newest while an iOS
// build was the one actually being released.
const sharedAppBuilds = {
  data: [
    {
      id: "build-mac-47",
      attributes: {
        version: "47",
        uploadedDate: "2026-07-14T14:09:33-07:00",
        computedMinMacOsVersion: "12.0",
      },
      relationships: { preReleaseVersion: { data: { id: "pr-mac" } } },
    },
    {
      id: "build-ios-29",
      attributes: { version: "29", uploadedDate: "2026-07-15T09:41:44-07:00" },
      relationships: { preReleaseVersion: { data: { id: "pr-ios" } } },
    },
    {
      id: "build-ios-28",
      attributes: { version: "28", uploadedDate: "2026-06-30T10:00:00-07:00" },
      relationships: { preReleaseVersion: { data: { id: "pr-ios" } } },
    },
  ],
  included: [
    { type: "preReleaseVersions", id: "pr-mac", attributes: { platform: "MAC_OS" } },
    { type: "preReleaseVersions", id: "pr-ios", attributes: { platform: "IOS" } },
  ],
};

// `filter[version]=29` fixture — mirrors the LIVE ASC response: build number 29
// exists on BOTH platforms (macOS passed through 29 months ago), so an exact
// build-number filter returns two builds and platform must disambiguate.
const buildNumber29 = {
  data: [
    {
      id: "build-ios-29",
      attributes: { version: "29", uploadedDate: "2026-07-15T09:41:44-07:00" },
      relationships: { preReleaseVersion: { data: { id: "pr-ios" } } },
    },
    {
      id: "build-mac-29-old",
      attributes: {
        version: "29",
        uploadedDate: "2026-06-22T13:42:57-07:00",
        computedMinMacOsVersion: "12.0",
      },
      relationships: { preReleaseVersion: { data: { id: "pr-mac" } } },
    },
  ],
  included: [
    { type: "preReleaseVersions", id: "pr-ios", attributes: { platform: "IOS" } },
    { type: "preReleaseVersions", id: "pr-mac", attributes: { platform: "MAC_OS" } },
  ],
};

describe("parseArgs", () => {
  it("parses a full invocation", () => {
    assert.deepEqual(parseArgs(["--platform", "ios", "--notes", "Fixed things", "--build", "29"]), {
      platform: "ios",
      notes: "Fixed things",
      build: "29",
    });
  });

  it("does not consume the next flag as a value", () => {
    // `--notes --build 29` must NOT treat "--build" as the notes text.
    const parsed = parseArgs(["--platform", "ios", "--notes", "--build", "29"]);
    assert.equal(parsed.notes, "");
    assert.equal(parsed.build, "29");
  });

  it("defaults platform to all and leaves notes/build empty when absent", () => {
    assert.deepEqual(parseArgs([]), { platform: "all", notes: "", build: "" });
  });

  it("treats a trailing flag with no value as empty", () => {
    assert.equal(parseArgs(["--notes"]).notes, "");
  });
});

describe("normalizeBuilds", () => {
  it("reads platform from the preReleaseVersion include", () => {
    const builds = normalizeBuilds(sharedAppBuilds);
    assert.deepEqual(builds, [
      {
        id: "build-mac-47",
        version: "47",
        uploadedDate: "2026-07-14T14:09:33-07:00",
        platform: "MAC_OS",
      },
      {
        id: "build-ios-29",
        version: "29",
        uploadedDate: "2026-07-15T09:41:44-07:00",
        platform: "IOS",
      },
      {
        id: "build-ios-28",
        version: "28",
        uploadedDate: "2026-06-30T10:00:00-07:00",
        platform: "IOS",
      },
    ]);
  });

  it("falls back to macOS-only build fields when the include linkage is absent", () => {
    const builds = normalizeBuilds({
      data: [
        {
          id: "m",
          attributes: { version: "50", lsMinimumSystemVersion: "12.0" },
          relationships: {},
        },
        { id: "i", attributes: { version: "51" }, relationships: {} },
      ],
      included: [],
    });
    assert.equal(builds.find((b) => b.id === "m").platform, "MAC_OS");
    assert.equal(builds.find((b) => b.id === "i").platform, "IOS");
  });

  it("tolerates a missing data/included array", () => {
    assert.deepEqual(normalizeBuilds({}), []);
  });
});

describe("selectTestFlightBuild", () => {
  it("regression: targets the iOS build by number, never the newer macOS build", () => {
    // Before the fix, the script took the newest uploaded build (macOS 47) and
    // wrote the iOS notes onto it, leaving the iOS build with none.
    const target = selectTestFlightBuild(normalizeBuilds(sharedAppBuilds), { buildNumber: "29" });
    assert.equal(target.id, "build-ios-29");
    assert.equal(target.platform, "IOS");
    assert.equal(target.version, "29");
  });

  it("picks the iOS build when the same build number exists on macOS (live-data shape)", () => {
    // filter[version]=29 returns iOS 29 AND an old macOS 29; must pick iOS.
    const target = selectTestFlightBuild(normalizeBuilds(buildNumber29), { buildNumber: "29" });
    assert.equal(target.id, "build-ios-29");
    assert.equal(target.platform, "IOS");
  });

  it("accepts a numeric build number", () => {
    assert.equal(
      selectTestFlightBuild(normalizeBuilds(sharedAppBuilds), { buildNumber: 28 }).id,
      "build-ios-28",
    );
  });

  it("never crosses to a macOS build even when its number matches", () => {
    // "47" is a macOS build number; there is no iOS 47 → no target (safe skip),
    // rather than silently writing to the macOS build.
    assert.equal(
      selectTestFlightBuild(normalizeBuilds(sharedAppBuilds), { buildNumber: "47" }),
      null,
    );
  });

  it("breaks ties on a reused iOS build number by newest upload", () => {
    const dupes = [
      {
        id: "ios-29-old",
        version: "29",
        platform: "IOS",
        uploadedDate: "2026-05-01T00:00:00-07:00",
      },
      {
        id: "ios-29-new",
        version: "29",
        platform: "IOS",
        uploadedDate: "2026-07-15T09:41:44-07:00",
      },
    ];
    assert.equal(selectTestFlightBuild(dupes, { buildNumber: "29" }).id, "ios-29-new");
  });

  it("falls back to the newest iOS build when no number is given", () => {
    // Newest overall is macOS 47; newest IOS is 29 (uploaded after 28).
    assert.equal(selectTestFlightBuild(normalizeBuilds(sharedAppBuilds), {}).id, "build-ios-29");
  });

  it("returns null when there are no iOS builds", () => {
    const macOnly = normalizeBuilds({
      data: [
        {
          id: "build-mac-47",
          attributes: { version: "47", computedMinMacOsVersion: "12.0" },
          relationships: { preReleaseVersion: { data: { id: "pr-mac" } } },
        },
      ],
      included: [{ type: "preReleaseVersions", id: "pr-mac", attributes: { platform: "MAC_OS" } }],
    });
    assert.equal(selectTestFlightBuild(macOnly, { buildNumber: "29" }), null);
  });
});
