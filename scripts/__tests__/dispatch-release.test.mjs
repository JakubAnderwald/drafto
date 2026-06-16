import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  derivePlatforms,
  platformsToLanes,
  assertBetaOnly,
  dispatchLanes,
  _setSpawnForTests,
} from "../lib/dispatch-release.mjs";

afterEach(() => _setSpawnForTests(null));

describe("derivePlatforms", () => {
  it("maps apps/* prefixes to platforms", () => {
    assert.deepEqual(derivePlatforms("apps/mobile/src/x.ts"), {
      mobile: true,
      desktop: false,
      web: false,
    });
    assert.deepEqual(derivePlatforms("apps/desktop/src/x.ts"), {
      mobile: false,
      desktop: true,
      web: false,
    });
    assert.deepEqual(derivePlatforms("apps/web/src/x.ts"), {
      mobile: false,
      desktop: false,
      web: true,
    });
  });

  it("treats packages/shared as both native platforms", () => {
    assert.deepEqual(derivePlatforms("packages/shared/src/x.ts"), {
      mobile: true,
      desktop: true,
      web: false,
    });
  });

  it("handles a mixed multi-line diff", () => {
    const diff = "apps/web/a.ts\napps/mobile/b.ts\ndocs/x.md\n";
    assert.deepEqual(derivePlatforms(diff), { mobile: true, desktop: false, web: true });
  });

  it("returns all-false for an empty / non-app diff", () => {
    assert.deepEqual(derivePlatforms(""), { mobile: false, desktop: false, web: false });
    assert.deepEqual(derivePlatforms("scripts/x.mjs\ndocs/y.md"), {
      mobile: false,
      desktop: false,
      web: false,
    });
  });
});

describe("platformsToLanes", () => {
  it("mobile → apps/mobile pnpm release:beta:all", () => {
    assert.deepEqual(platformsToLanes({ mobile: true }), [
      { id: "mobile", cwd: "apps/mobile", command: "pnpm", args: ["release:beta:all"] },
    ]);
  });
  it("desktop → apps/desktop pnpm release:beta", () => {
    assert.deepEqual(platformsToLanes({ desktop: true }), [
      { id: "desktop", cwd: "apps/desktop", command: "pnpm", args: ["release:beta"] },
    ]);
  });
  it("both native → two lanes", () => {
    assert.equal(platformsToLanes({ mobile: true, desktop: true }).length, 2);
  });
  it("web-only → no lanes (Vercel deploys main)", () => {
    assert.deepEqual(platformsToLanes({ web: true }), []);
    assert.deepEqual(platformsToLanes({}), []);
  });
});

describe("assertBetaOnly (prod-never invariant)", () => {
  it("allows the real beta lanes", () => {
    for (const lane of platformsToLanes({ mobile: true, desktop: true })) {
      assert.doesNotThrow(() => assertBetaOnly(lane));
    }
  });
  it("throws on any production lane", () => {
    assert.throws(
      () => assertBetaOnly({ command: "pnpm", args: ["release:prod:ios"] }),
      /non-beta/,
    );
    assert.throws(
      () => assertBetaOnly({ command: "pnpm", args: ["release:production"] }),
      /non-beta/,
    );
    assert.throws(
      () => assertBetaOnly({ command: "bundle", args: ["exec", "fastlane", "mac", "production"] }),
      /non-beta/,
    );
  });
});

describe("dispatchLanes (mocked spawn — no real Fastlane)", () => {
  it("spawns the mobile lane in apps/mobile under repoRoot", () => {
    const calls = [];
    _setSpawnForTests((lane, opts) => calls.push({ lane, opts }));
    const out = dispatchLanes({ repoRoot: "/repo", diffFiles: "apps/mobile/x.ts" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].lane.id, "mobile");
    assert.deepEqual(calls[0].lane.args, ["release:beta:all"]);
    assert.equal(calls[0].opts.repoRoot, "/repo");
    assert.deepEqual(
      out.dispatched.map((d) => d.id),
      ["mobile"],
    );
  });

  it("dispatches both native lanes for packages/shared changes", () => {
    const calls = [];
    _setSpawnForTests((lane) => calls.push(lane.id));
    const out = dispatchLanes({ repoRoot: ".", diffFiles: "packages/shared/x.ts" });
    assert.deepEqual(calls.sort(), ["desktop", "mobile"]);
    assert.equal(out.dispatched.length, 2);
  });

  it("dispatches nothing for a web-only change", () => {
    const calls = [];
    _setSpawnForTests(() => calls.push(1));
    const out = dispatchLanes({ diffFiles: "apps/web/x.ts" });
    assert.equal(calls.length, 0);
    assert.deepEqual(out.dispatched, []);
  });

  it("dryRun records the lanes without spawning", () => {
    const calls = [];
    _setSpawnForTests(() => calls.push(1));
    const out = dispatchLanes({ diffFiles: "apps/mobile/x.ts", dryRun: true });
    assert.equal(calls.length, 0);
    assert.deepEqual(
      out.dispatched.map((d) => d.id),
      ["mobile"],
    );
  });

  it("never constructs a production command", () => {
    const cmds = [];
    _setSpawnForTests((lane) => cmds.push(`${lane.command} ${lane.args.join(" ")}`));
    dispatchLanes({ diffFiles: "apps/mobile/x.ts\napps/desktop/y.ts" });
    for (const c of cmds) assert.doesNotMatch(c, /prod|production/i);
  });
});
