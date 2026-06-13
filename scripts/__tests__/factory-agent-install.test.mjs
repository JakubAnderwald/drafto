import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests for issue #451 (observation 2). A fresh-worktree
// `pnpm install` ran for 3.5+ hours because the pnpm store is on an external
// volume and a cold install cross-device-copies ~2000 packages, and nothing
// bounded it (the implement timeout only wraps the claude call). The fix:
//   - seed node_modules from the main checkout via APFS clonefile (cp -c)
//   - run a fast offline reconcile wrapped by run-with-timeout.mjs (cap)
//   - guard against a near-full disk by parking the card in Blocked
// These tests lock the script source against regressing those changes, and
// exercise the real seed helper on macOS (where clonefile is available).

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

describe("factory-agent install: clonefile seed + bounded reconcile (#451)", () => {
  it("defines the seed / install / free-disk helpers", () => {
    assert.match(script, /^seed_worktree_node_modules\(\) \{/m, "seed helper must exist");
    assert.match(script, /^run_pnpm_install\(\) \{/m, "install helper must exist");
    assert.match(script, /^free_disk_gb\(\) \{/m, "free-disk helper must exist");
  });

  it("seeds via APFS clonefile from the pnpm workspace roots only", () => {
    assert.match(script, /cp -c -R "\$src" "\$wt\/\$rel"/, "must clone with `cp -c -R`");
    // root + apps/* + packages/* — never the factory's own worktrees/ checkouts.
    assert.match(
      script,
      /"\$REPO_ROOT"\/node_modules "\$REPO_ROOT"\/apps\/\*\/node_modules "\$REPO_ROOT"\/packages\/\*\/node_modules/,
      "must enumerate root + apps/* + packages/* node_modules",
    );
    assert.match(
      script,
      /\[\[ -e "\$wt\/\$rel" \]\] && continue/,
      "must skip already-present trees (idempotent / reused worktree)",
    );
  });

  it("bounds every install attempt with run-with-timeout.mjs and tries offline first", () => {
    assert.match(
      script,
      /run-with-timeout\.mjs" "\$INSTALL_TIMEOUT_SEC"/,
      "install must be capped",
    );
    assert.match(
      script,
      /pnpm install --frozen-lockfile --offline --prefer-offline/,
      "first attempt must be a fast offline reconcile",
    );
    assert.match(script, /INSTALL_TIMEOUT_SEC="\$\{FACTORY_INSTALL_TIMEOUT_SEC:-600\}"/);
  });

  it("does not run pnpm install unbounded (no bare `cd <wt> && pnpm install`)", () => {
    // The old form ran pnpm directly with no wall-clock cap, so a hung install
    // held the implement lock for hours. Every install now goes through
    // run_pnpm_install → run-with-timeout.mjs.
    assert.doesNotMatch(
      script,
      /cd "\$WT_PATH" && pnpm install/,
      "implement path must not call pnpm install directly",
    );
    assert.doesNotMatch(
      script,
      /cd "\$wt" && pnpm install/,
      "run_pnpm_install must wrap pnpm with run-with-timeout, not call it directly",
    );
  });

  it("guards a near-full disk by parking the card in Blocked with a comment", () => {
    assert.match(script, /FACTORY_MIN_FREE_DISK_GB="\$\{FACTORY_MIN_FREE_DISK_GB:-3\}"/);
    // Scope to the guard block (between its comment and the plan check) so the
    // threshold check, marker comment and Blocked transition are proven to be
    // wired together, not merely present somewhere in the script.
    const guard = script.match(/# Free-disk guard[\s\S]*?# The approved plan must be present/);
    assert.ok(guard, "disk guard block must precede the plan check");
    assert.match(guard[0], /FREE_GB=\$\(free_disk_gb\)/, "must read free disk");
    assert.match(
      guard[0],
      /FREE_GB" -lt "\$FACTORY_MIN_FREE_DISK_GB"/,
      "must compare to threshold",
    );
    assert.match(guard[0], /drafto-factory-disk-low/, "must post the disk-low marker comment");
    assert.match(
      guard[0],
      /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Blocked"/,
      "low disk must transition the card to Blocked",
    );
  });

  it("wires the seed + bounded install into both the implement and watch paths", () => {
    const seedCalls = script.match(/seed_worktree_node_modules "\$WT_PATH"/g) || [];
    const installCalls = script.match(/run_pnpm_install "\$WT_PATH"/g) || [];
    assert.ok(seedCalls.length >= 2, "seed must run in both implement and watch paths");
    assert.ok(
      installCalls.length >= 2,
      "bounded install must run in both implement and watch paths",
    );
  });
});

describe("seed_worktree_node_modules (real helper, macOS clonefile)", () => {
  // cp -c (clonefile) is macOS-only; the factory only runs on the Mac mini.
  const darwinOnly = process.platform !== "darwin" ? "clonefile (cp -c) is macOS-only" : false;

  // Extract the real function body from the script and run it in a harness with
  // REPO_ROOT / LOG_FILE / log() stubbed, against throwaway temp dirs.
  function runSeed(repoRoot, worktree) {
    const fn = script.match(/seed_worktree_node_modules\(\) \{[\s\S]*?\n\}/);
    assert.ok(fn, "could not extract seed_worktree_node_modules from the script");
    const harness = [
      "set -euo pipefail",
      `REPO_ROOT=${JSON.stringify(repoRoot)}`,
      "LOG_FILE=/dev/null",
      "log() { :; }",
      fn[0],
      `seed_worktree_node_modules ${JSON.stringify(worktree)}`,
    ].join("\n");
    return spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  }

  it(
    "clones root + apps/* + packages/* node_modules into a fresh worktree",
    { skip: darwinOnly },
    () => {
      const base = mkdtempSync(join(tmpdir(), "factory-seed-"));
      try {
        const repo = join(base, "main");
        const wt = join(base, "wt");
        for (const rel of [
          "node_modules",
          "apps/web/node_modules",
          "packages/shared/node_modules",
        ]) {
          mkdirSync(join(repo, rel), { recursive: true });
          writeFileSync(join(repo, rel, "marker.txt"), rel);
        }
        // A factory worktrees/ checkout that must NOT be seeded.
        mkdirSync(join(repo, "worktrees/old/node_modules"), { recursive: true });
        mkdirSync(wt, { recursive: true });

        const res = runSeed(repo, wt);
        assert.equal(res.status, 0, `seed exited non-zero: ${res.stderr}`);
        for (const rel of [
          "node_modules",
          "apps/web/node_modules",
          "packages/shared/node_modules",
        ]) {
          assert.ok(
            existsSync(join(wt, rel, "marker.txt")),
            `expected ${rel} cloned into worktree`,
          );
        }
        assert.ok(
          !existsSync(join(wt, "worktrees")),
          "must not seed the factory's own worktrees/ checkouts",
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it(
    "is idempotent — re-running over an existing tree is a no-op success",
    { skip: darwinOnly },
    () => {
      const base = mkdtempSync(join(tmpdir(), "factory-seed-"));
      try {
        const repo = join(base, "main");
        const wt = join(base, "wt");
        mkdirSync(join(repo, "node_modules"), { recursive: true });
        writeFileSync(join(repo, "node_modules", "marker.txt"), "v1");
        mkdirSync(wt, { recursive: true });

        assert.equal(runSeed(repo, wt).status, 0);
        // Mutate the source; a second seed must NOT overwrite the existing tree.
        writeFileSync(join(repo, "node_modules", "marker.txt"), "v2");
        assert.equal(runSeed(repo, wt).status, 0, "second seed must succeed");
        assert.equal(
          readFileSync(join(wt, "node_modules", "marker.txt"), "utf8"),
          "v1",
          "existing worktree tree must be preserved (skip when present)",
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});
