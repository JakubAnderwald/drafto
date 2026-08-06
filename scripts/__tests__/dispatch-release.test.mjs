import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  derivePlatforms,
  platformsToLanes,
  assertBetaOnly,
  resolveLaneRoot,
  assertDesktopFossil,
  dispatchLanes,
  DESKTOP_FOSSIL_ROOT_DEFAULT,
  _setSpawnForTests,
} from "../lib/dispatch-release.mjs";

afterEach(() => _setSpawnForTests(null));

// A throwaway checkout whose node_modules/react declares `version`; omit the
// version to leave react absent entirely.
function fakeCheckout(version) {
  const root = mkdtempSync(join(tmpdir(), "drafto-fossil-"));
  if (version !== undefined) {
    const dir = join(root, "node_modules", "react");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "react", version }));
  }
  return root;
}

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

describe("dispatch-premerge CLI", () => {
  const CLI = fileURLToPath(new URL("../lib/dispatch-release.mjs", import.meta.url));
  const run = (args) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });

  it("requires --issue (the card the build belongs to)", () => {
    const r = run(["dispatch-premerge", "--platforms", "mobile", "--dry-run"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires --issue/);
  });

  it("dry-runs a mobile lane without spawning anything", () => {
    const r = run([
      "dispatch-premerge",
      "--platforms",
      "mobile",
      "--issue",
      "463",
      "--pr",
      "591",
      "--sha",
      "abc123",
      "--dry-run",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(
      out.dispatched.map((d) => d.id),
      ["mobile"],
    );
    assert.deepEqual(out.skipped, []);
  });

  it("refuses a desktop lane whose root is not a fossil, even in the CLI", () => {
    const stale = fakeCheckout("19.2.6");
    try {
      const r = run([
        "dispatch-premerge",
        "--platforms",
        "desktop",
        "--desktop-root",
        stale,
        "--issue",
        "463",
        "--dry-run",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.dispatched, []);
      assert.equal(out.skipped[0].id, "desktop");
    } finally {
      rmSync(stale, { recursive: true, force: true });
    }
  });

  it("keeps the legacy `dispatch` subcommand working", () => {
    const r = run(["dispatch", "--platforms", "mobile", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      JSON.parse(r.stdout).dispatched.map((d) => d.id),
      ["mobile"],
    );
  });
});

describe("resolveLaneRoot (desktop never builds from repoRoot)", () => {
  const mobile = { id: "mobile" };
  const desktop = { id: "desktop" };

  it("keeps non-desktop lanes on repoRoot", () => {
    assert.equal(resolveLaneRoot(mobile, { repoRoot: "/repo", env: {} }), "/repo");
  });

  it("sends desktop to the fossil root, not repoRoot", () => {
    const root = resolveLaneRoot(desktop, { repoRoot: "/factory-checkout", env: {} });
    assert.equal(root, DESKTOP_FOSSIL_ROOT_DEFAULT);
    assert.notEqual(root, "/factory-checkout");
  });

  it("prefers an explicit desktopRoot over the env and the default", () => {
    const root = resolveLaneRoot(desktop, {
      repoRoot: "/repo",
      desktopRoot: "/explicit",
      env: { DRAFTO_DESKTOP_BUILD_ROOT: "/from-env" },
    });
    assert.equal(root, "/explicit");
  });

  it("falls back to DRAFTO_DESKTOP_BUILD_ROOT when no explicit root is given", () => {
    const root = resolveLaneRoot(desktop, {
      repoRoot: "/repo",
      env: { DRAFTO_DESKTOP_BUILD_ROOT: "/from-env" },
    });
    assert.equal(root, "/from-env");
  });
});

describe("assertDesktopFossil", () => {
  it("accepts a 19.1.x checkout and returns the version", () => {
    const root = fakeCheckout("19.1.4");
    try {
      assert.equal(assertDesktopFossil(root), "19.1.4");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a 19.2.x checkout (compiles, then crashes at runtime)", () => {
    const root = fakeCheckout("19.2.6");
    try {
      assert.throws(() => assertDesktopFossil(root), /not 19\.1\.x/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a checkout with no installed react at all", () => {
    const root = fakeCheckout(undefined);
    try {
      assert.throws(() => assertDesktopFossil(root), /no readable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    const fossil = fakeCheckout("19.1.4");
    try {
      const calls = [];
      _setSpawnForTests((lane) => calls.push(lane.id));
      const out = dispatchLanes({
        repoRoot: ".",
        desktopRoot: fossil,
        diffFiles: "packages/shared/x.ts",
      });
      assert.deepEqual(calls.sort(), ["desktop", "mobile"]);
      assert.equal(out.dispatched.length, 2);
      assert.deepEqual(out.skipped, []);
    } finally {
      rmSync(fossil, { recursive: true, force: true });
    }
  });

  it("builds desktop from the fossil root, mobile from repoRoot", () => {
    const fossil = fakeCheckout("19.1.4");
    try {
      const roots = {};
      _setSpawnForTests((lane, opts) => (roots[lane.id] = opts.repoRoot));
      dispatchLanes({
        repoRoot: "/factory-checkout",
        desktopRoot: fossil,
        diffFiles: "packages/shared/x.ts",
      });
      assert.equal(roots.mobile, "/factory-checkout");
      assert.equal(roots.desktop, fossil);
    } finally {
      rmSync(fossil, { recursive: true, force: true });
    }
  });

  it("skips only the desktop lane when its root lost the fossil", () => {
    const stale = fakeCheckout("19.2.6");
    try {
      const calls = [];
      _setSpawnForTests((lane) => calls.push(lane.id));
      const out = dispatchLanes({
        repoRoot: "/repo",
        desktopRoot: stale,
        diffFiles: "packages/shared/x.ts",
      });
      // The mobile beta still ships; desktop is refused with a reason.
      assert.deepEqual(calls, ["mobile"]);
      assert.deepEqual(
        out.dispatched.map((d) => d.id),
        ["mobile"],
      );
      assert.equal(out.skipped.length, 1);
      assert.equal(out.skipped[0].id, "desktop");
      assert.match(out.skipped[0].reason, /not 19\.1\.x/);
    } finally {
      rmSync(stale, { recursive: true, force: true });
    }
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

  it("captures lane output to a log instead of discarding it", () => {
    // Regression: stdio was "ignore", so a lane that died on startup was
    // indistinguishable from one building for 40 minutes — and since the caller
    // records the SHA key on dispatch, that made the failure permanent and
    // undiagnosable. Observed live on #463.
    let seen = null;
    _setSpawnForTests((lane, opts) => {
      seen = opts;
      return { pid: 4242, logPath: "/tmp/beta-lane-mobile.log" };
    });
    const out = dispatchLanes({
      repoRoot: "/repo",
      diffFiles: "apps/mobile/x.ts",
      logDir: "/tmp/does-not-matter",
    });
    assert.equal(seen.logDir, "/tmp/does-not-matter", "logDir must reach the spawner");
    assert.equal(out.dispatched[0].pid, 4242);
    assert.equal(out.dispatched[0].logPath, "/tmp/beta-lane-mobile.log");
  });

  it("survives a lane that cannot start at all, and records why", async () => {
    // spawn() reports "couldn't start" via an ASYNC 'error' event; unhandled, it
    // rethrows and takes the dispatcher down mid-loop, so one unlaunchable lane
    // would abort the other and the caller would see a crash, not a skip.
    // Uses the REAL spawner against a command that cannot resolve.
    const dir = mkdtempSync(join(tmpdir(), "drafto-lanelog-"));
    try {
      const out = dispatchLanes({
        repoRoot: "/definitely/not/a/real/root",
        platforms: { mobile: true },
        logDir: dir,
      });
      assert.equal(out.dispatched.length, 1, "dispatcher must survive");
      await new Promise((r) => setTimeout(r, 300));
      const log = readFileSync(out.dispatched[0].logPath, "utf8");
      assert.match(log, /failed to start/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits pid/logPath under dryRun (nothing was spawned)", () => {
    _setSpawnForTests(() => ({ pid: 1, logPath: "/x" }));
    const out = dispatchLanes({ diffFiles: "apps/mobile/x.ts", dryRun: true });
    assert.equal(out.dispatched[0].pid, undefined);
    assert.equal(out.dispatched[0].logPath, undefined);
  });

  it("injects laneEnv into the spawned lane (pre-merge build identification)", () => {
    let seen = null;
    _setSpawnForTests((lane, opts) => (seen = opts));
    dispatchLanes({
      repoRoot: "/repo",
      diffFiles: "apps/mobile/x.ts",
      laneEnv: { DRAFTO_INTEST_ISSUE: "463", DRAFTO_INTEST_PR: "591" },
    });
    assert.equal(seen.laneEnv.DRAFTO_INTEST_ISSUE, "463");
    assert.equal(seen.laneEnv.DRAFTO_INTEST_PR, "591");
  });

  it("never constructs a production command", () => {
    const fossil = fakeCheckout("19.1.4");
    try {
      const cmds = [];
      _setSpawnForTests((lane) => cmds.push(`${lane.command} ${lane.args.join(" ")}`));
      dispatchLanes({
        desktopRoot: fossil,
        diffFiles: "apps/mobile/x.ts\napps/desktop/y.ts",
      });
      assert.equal(cmds.length, 2);
      for (const c of cmds) assert.doesNotMatch(c, /prod|production/i);
    } finally {
      rmSync(fossil, { recursive: true, force: true });
    }
  });
});
