import { describe, it, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
import {
  normalizeBuilds,
  parseArgs,
  selectTestFlightBuild,
  ascFetch,
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

// --- transient-failure retries ---------------------------------------------
//
// iOS build 32 shipped to a tester with an EMPTY "What to Test". The cause was
// not the "build not indexed yet" poll (which retries a good response lacking
// the build) but a thrown network error, which escaped that loop entirely:
//   [17:54:16] TestFlight error: fetch failed
//   [17:54:28] Release notes posting failed (non-fatal)
// Fastlane rescues that as non-fatal, so nothing failed and the notes were
// simply never written. One dropped socket must not cost a release its notes.

describe("ascFetch (transient-failure retries)", () => {
  const realFetch = globalThis.fetch;
  const realBackoff = process.env.DRAFTO_ASC_RETRY_BASE_MS;
  // Shorten the backoff here rather than relying on the runner's environment,
  // so `node --test` alone exercises the same paths without a ~14s sleep.
  process.env.DRAFTO_ASC_RETRY_BASE_MS = "1";
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(() => {
    if (realBackoff === undefined) delete process.env.DRAFTO_ASC_RETRY_BASE_MS;
    else process.env.DRAFTO_ASC_RETRY_BASE_MS = realBackoff;
  });

  const ok = (status = 200) => ({ status, ok: status < 400 });

  it("retries a thrown network error and succeeds — the build-32 failure", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok();
    };
    const res = await ascFetch("https://example.test/builds");
    assert.equal(res.status, 200);
    assert.equal(calls, 2, "must retry after a network error, not give up");
  });

  it("retries 5xx / 429 / 408 but NOT a 4xx the caller must see", async () => {
    for (const [status, expectedCalls] of [
      [500, 2],
      [503, 2],
      [429, 2],
      [408, 2],
      [401, 1],
      [404, 1],
      [409, 1],
    ]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return calls === 1 ? ok(status) : ok(200);
      };
      const res = await ascFetch("https://example.test/builds");
      assert.equal(
        calls,
        expectedCalls,
        `status ${status}: expected ${expectedCalls} call(s), got ${calls}`,
      );
      if (expectedCalls === 1) assert.equal(res.status, status, "a 4xx must reach the caller");
    }
  });

  it("gives up after the attempt cap and rethrows, rather than hanging forever", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };
    await assert.rejects(() => ascFetch("https://example.test/builds"), /fetch failed/);
    assert.equal(calls, 4, "a sustained outage must still terminate");
  });

  it("passes caller options through (headers/method must survive the retry wrapper)", async () => {
    let seen = null;
    globalThis.fetch = async (_url, opts) => {
      seen = opts;
      return ok();
    };
    await ascFetch("https://example.test/x", { method: "PATCH", headers: { A: "b" } });
    assert.equal(seen.method, "PATCH");
    assert.deepEqual(seen.headers, { A: "b" });
    assert.ok(seen.signal, "the per-request timeout must still be applied");
  });
});

describe("mobile/desktop mirror invariant", () => {
  // These two copies had silently diverged: desktop's had no timeout and no
  // retry at all, and its release-notes generator kept a `--grep` classifier
  // that mobile's fix never reached. CLAUDE.md requires the platforms stay in
  // sync; assert the properties rather than trusting a future edit to remember.
  const read = (p) => readFileSync(resolve(HERE, "..", "..", p), "utf8");

  for (const p of [
    "apps/mobile/scripts/post-release-notes.mjs",
    "apps/desktop/scripts/post-release-notes.mjs",
  ]) {
    it(`${p} bounds and retries its App Store Connect requests`, () => {
      const src = read(p);
      assert.match(src, /AbortSignal\.timeout\(ASC_REQUEST_TIMEOUT_MS\)/, "no per-request timeout");
      assert.match(src, /ASC_RETRY_ATTEMPTS/, "no retry cap");
      // Scoped to App Store Connect. The Google Play calls in the mobile copy
      // deliberately use raw fetch: they form an edit/commit transaction, where
      // a blind retry could re-run a step against an already-invalidated edit.
      for (const asc of [
        /await fetch\([^\n]*betaBuildLocalizations/,
        /await fetch\([^\n]*\/builds\?/,
      ]) {
        assert.ok(!asc.test(src), `an ASC request bypasses the retry wrapper: ${asc}`);
      }
      assert.ok(src.includes("await ascFetch("), "ASC requests must go through ascFetch");
    });
  }

  for (const p of [
    "apps/mobile/scripts/generate-release-notes.sh",
    "apps/desktop/scripts/generate-release-notes.sh",
  ]) {
    it(`${p} classifies from the subject, never via --grep`, () => {
      const src = read(p);
      assert.ok(
        !/--grep="\^(feat|fix)"/.test(src),
        "--grep matches the whole message; a body line starting with 'fix' miscategorises the commit",
      );
      assert.match(src, /sed -nE 's\/\^feat/, "feat must be filtered+stripped in one pass");
      assert.match(src, /sed -nE 's\/\^fix/, "fix must be filtered+stripped in one pass");
    });
  }
});
