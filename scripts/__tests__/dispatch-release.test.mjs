import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  derivePlatforms,
  platformsToLanes,
  assertBetaOnly,
  resolveLaneRoot,
  assertDesktopFossil,
  laneShellScript,
  laneLogPath,
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
  it("spawns the mobile lane in apps/mobile under repoRoot", async () => {
    const calls = [];
    _setSpawnForTests((lane, opts) => calls.push({ lane, opts }));
    const out = await dispatchLanes({ repoRoot: "/repo", diffFiles: "apps/mobile/x.ts" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].lane.id, "mobile");
    assert.deepEqual(calls[0].lane.args, ["release:beta:all"]);
    assert.equal(calls[0].opts.repoRoot, "/repo");
    assert.deepEqual(
      out.dispatched.map((d) => d.id),
      ["mobile"],
    );
  });

  it("dispatches both native lanes for packages/shared changes", async () => {
    const fossil = fakeCheckout("19.1.4");
    try {
      const calls = [];
      _setSpawnForTests((lane) => calls.push(lane.id));
      const out = await dispatchLanes({
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

  it("builds desktop from the fossil root, mobile from repoRoot", async () => {
    const fossil = fakeCheckout("19.1.4");
    try {
      const roots = {};
      _setSpawnForTests((lane, opts) => (roots[lane.id] = opts.repoRoot));
      await dispatchLanes({
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

  it("skips only the desktop lane when its root lost the fossil", async () => {
    const stale = fakeCheckout("19.2.6");
    try {
      const calls = [];
      _setSpawnForTests((lane) => calls.push(lane.id));
      const out = await dispatchLanes({
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

  it("dispatches nothing for a web-only change", async () => {
    const calls = [];
    _setSpawnForTests(() => calls.push(1));
    const out = await dispatchLanes({ diffFiles: "apps/web/x.ts" });
    assert.equal(calls.length, 0);
    assert.deepEqual(out.dispatched, []);
  });

  it("dryRun records the lanes without spawning", async () => {
    const calls = [];
    _setSpawnForTests(() => calls.push(1));
    const out = await dispatchLanes({ diffFiles: "apps/mobile/x.ts", dryRun: true });
    assert.equal(calls.length, 0);
    assert.deepEqual(
      out.dispatched.map((d) => d.id),
      ["mobile"],
    );
  });

  it("captures lane output to a log instead of discarding it", async () => {
    // Regression: stdio was "ignore", so a lane that died on startup was
    // indistinguishable from one building for 40 minutes — and since the caller
    // records the SHA key on dispatch, that made the failure permanent and
    // undiagnosable. Observed live on #463.
    let seen = null;
    _setSpawnForTests((lane, opts) => {
      seen = opts;
      return { pid: 4242, logPath: "/tmp/beta-lane-mobile.log" };
    });
    const out = await dispatchLanes({
      repoRoot: "/repo",
      diffFiles: "apps/mobile/x.ts",
      logDir: "/tmp/does-not-matter",
    });
    assert.equal(seen.logDir, "/tmp/does-not-matter", "logDir must reach the spawner");
    assert.equal(out.dispatched[0].pid, 4242);
    assert.equal(out.dispatched[0].logPath, "/tmp/beta-lane-mobile.log");
  });

  it("reports an unstartable lane as failed, NOT dispatched", async () => {
    // The whole point: `dispatched` is what suppresses a retry, so a lane that
    // never started must not appear there. Previously it did — the function
    // returned before the async 'error' could fire — which made the failure
    // permanent. Uses the REAL spawner against a cwd that cannot resolve.
    const dir = mkdtempSync(join(tmpdir(), "drafto-lanelog-"));
    try {
      const out = await dispatchLanes({
        repoRoot: "/definitely/not/a/real/root",
        platforms: { mobile: true },
        logDir: dir,
      });
      assert.deepEqual(out.dispatched, [], "an unstartable lane must not count as dispatched");
      assert.equal(out.failed.length, 1, "it must be reported as failed");
      assert.equal(out.failed[0].id, "mobile");
      assert.match(out.failed[0].reason, /ENOENT|spawn/i);
      // The reason must also reach the lane log. Poll rather than sleep — a
      // fixed delay can lose the race on a loaded CI worker.
      const logPath = out.failed[0].logPath;
      const deadline = Date.now() + 5000;
      let log = "";
      while (Date.now() < deadline) {
        log = readFileSync(logPath, "utf8");
        if (/failed to start/.test(log)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.match(log, /failed to start/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a lane's real exit code next to its log", async () => {
    // Previously this passed repoRoot:"/" so the lane's cwd was /apps/mobile,
    // which exists nowhere — spawn failed, the test took an early return and
    // asserted nothing. Use a REAL cwd and a REAL command with a known exit.
    const dir = mkdtempSync(join(tmpdir(), "drafto-laneexit-"));
    const root = mkdtempSync(join(tmpdir(), "drafto-laneroot-"));
    mkdirSync(join(root, "apps", "mobile"), { recursive: true });
    try {
      _setSpawnForTests(null);
      // `pnpm` may be absent (CI); shim it so the lane's exit code is ours.
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "pnpm"), "#!/bin/sh\necho lane ran\nexit 7\n", { mode: 0o755 });
      const out = await dispatchLanes({
        repoRoot: root,
        platforms: { mobile: true },
        logDir: dir,
        logKey: "463-abc123-a1",
        laneEnv: { PATH: `${bin}:${process.env.PATH}` },
      });
      assert.equal(out.failed.length, 0, `lane should start: ${JSON.stringify(out.failed)}`);
      assert.equal(out.dispatched.length, 1);
      const exitPath = out.dispatched[0].exitPath;
      assert.ok(exitPath, "a started lane must report where its exit code lands");
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !existsSync(exitPath)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(exitPath), "the wrapper must write <log>.exit");
      assert.equal(
        readFileSync(exitPath, "utf8").trim(),
        "7",
        "the lane's OWN exit code must be recorded, not the wrapper's",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes artefacts per ATTEMPT, so a retry never shares a path", () => {
    const a1 = laneLogPath({ id: "mobile" }, { logDir: "/tmp/x", logKey: "463-abc123-a1" });
    const a2 = laneLogPath({ id: "mobile" }, { logDir: "/tmp/x", logKey: "463-abc123-a2" });
    assert.notEqual(a1, a2, "a retry of the SAME commit must not reuse the path");
  });

  it("laneShellScript captures $? immediately after the lane command", () => {
    const script = laneShellScript(
      { id: "mobile", command: "pnpm", args: ["release:beta:all"] },
      "/tmp/x.log",
    );
    assert.match(script, /^pnpm release:beta:all; echo \$\? > '\/tmp\/x\.log\.exit'$/);
  });

  it("omits pid/logPath under dryRun (nothing was spawned)", async () => {
    _setSpawnForTests(() => ({ pid: 1, logPath: "/x" }));
    const out = await dispatchLanes({ diffFiles: "apps/mobile/x.ts", dryRun: true });
    assert.equal(out.dispatched[0].pid, undefined);
    assert.equal(out.dispatched[0].logPath, undefined);
  });

  it("injects laneEnv into the spawned lane (pre-merge build identification)", async () => {
    let seen = null;
    _setSpawnForTests((lane, opts) => (seen = opts));
    await dispatchLanes({
      repoRoot: "/repo",
      diffFiles: "apps/mobile/x.ts",
      laneEnv: { DRAFTO_INTEST_ISSUE: "463", DRAFTO_INTEST_PR: "591" },
    });
    assert.equal(seen.laneEnv.DRAFTO_INTEST_ISSUE, "463");
    assert.equal(seen.laneEnv.DRAFTO_INTEST_PR, "591");
  });

  it("never constructs a production command", async () => {
    const fossil = fakeCheckout("19.1.4");
    try {
      const cmds = [];
      _setSpawnForTests((lane) => cmds.push(`${lane.command} ${lane.args.join(" ")}`));
      await dispatchLanes({
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
