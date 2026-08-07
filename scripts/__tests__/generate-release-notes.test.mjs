import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests for the TestFlight / Play "What to Test" generator.
//
// Both platforms shipped visibly wrong notes to real testers:
//
//   1. `git log --grep="^fix"` matches the WHOLE commit message and `^` anchors
//      at every line start, not just the subject. d951b75 ("feat(factory): …")
//      landed in BOTH buckets because line 39 of its body wrapped to
//      "fix is observable, plus what failure looks like…" — an English sentence.
//      It was then rendered under "Bug fixes" with its `feat(factory):` prefix
//      still attached, because the strip only removed a `fix:` prefix.
//
//   2. mobile's three-`sed` pipeline mangled every scoped commit:
//      `feat(web): export notebooks` → `web): export notebooks`.
//
// These run the REAL scripts against a purpose-built git repo, so the git
// invocation itself is exercised rather than pattern-matched.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const PLATFORMS = [
  { id: "mobile", script: resolve(REPO, "apps/mobile/scripts/generate-release-notes.sh") },
  { id: "desktop", script: resolve(REPO, "apps/desktop/scripts/generate-release-notes.sh") },
];

let dir;

function git(...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// Commit touching BOTH platform paths so one fixture serves both scripts.
function commit(message) {
  for (const p of ["apps/mobile", "apps/desktop"]) {
    mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, p, "f.txt"), message);
  }
  git("add", "-A");
  git("commit", "-m", message, "--no-verify");
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "drafto-relnotes-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");

  // The exact shape that broke: a `feat` whose BODY wraps onto a line starting
  // with the word "fix". Prose, not a conventional-commit prefix.
  commit(
    [
      "feat(factory): test scenarios + pre-merge beta builds at In Test (#595)",
      "",
      "It posts the In Test comment itself, opening with a reproduction so the",
      "fix is observable, plus what failure looks like and what is only covered",
      "by unit tests.",
    ].join("\n"),
  );
  commit("feat(web): export notebooks to Evernote .enex (#452)");
  commit("feat: add Google and Apple OAuth login (#275)");
  commit("fix(mobile): pin react-native to 0.83.6 (#582)");
  commit("fix: reset local WatermelonDB on sign-out");
  commit("chore: bump deps");
});

after(() => dir && rmSync(dir, { recursive: true, force: true }));

function runGenerator(script) {
  const r = spawnSync("bash", [script, "--max-chars", "4000"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `generator failed: ${r.stderr}`);
  return r.stdout;
}

function sections(out) {
  const featIdx = out.indexOf("What's new:");
  const fixIdx = out.indexOf("Bug fixes:");
  return {
    features: featIdx === -1 ? "" : out.slice(featIdx, fixIdx === -1 ? undefined : fixIdx),
    fixes: fixIdx === -1 ? "" : out.slice(fixIdx),
  };
}

for (const { id, script } of PLATFORMS) {
  describe(`generate-release-notes.sh (${id})`, () => {
    it("does not put a feat commit in Bug fixes because its BODY wrapped onto a 'fix' line", () => {
      const { features, fixes } = sections(runGenerator(script));
      assert.match(features, /test scenarios \+ pre-merge beta builds at In Test \(#595\)/);
      assert.ok(!/#595/.test(fixes), `the feat commit must not appear under Bug fixes:\n${fixes}`);
    });

    it("never emits a line with its conventional-commit prefix still attached", () => {
      const out = runGenerator(script);
      for (const line of out.split("\n").filter((l) => l.startsWith("- "))) {
        assert.ok(!/^- (feat|fix|chore)[(:]/.test(line), `prefix survived the strip: ${line}`);
      }
    });

    it("strips the scope, not just the type (feat(web): → the subject)", () => {
      const out = runGenerator(script);
      assert.match(out, /- export notebooks to Evernote \.enex \(#452\)/);
      assert.ok(!/web\):/.test(out), `scope fragment left behind:\n${out}`);
    });

    it("leaves no leading space on an unscoped subject", () => {
      const out = runGenerator(script);
      assert.match(out, /- add Google and Apple OAuth login \(#275\)/);
      assert.ok(!/- {2}add Google/.test(out), "unscoped subjects kept a leading space");
    });

    it("still groups real fixes under Bug fixes", () => {
      const { fixes } = sections(runGenerator(script));
      assert.match(fixes, /pin react-native to 0\.83\.6 \(#582\)/);
      assert.match(fixes, /reset local WatermelonDB on sign-out/);
    });

    it("omits commit types that are not feat or fix", () => {
      assert.ok(!/bump deps/.test(runGenerator(script)), "chore leaked into user-facing notes");
    });

    it("stamps the pre-merge banner when dispatched for an In Test card", () => {
      const r = spawnSync("bash", [script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          DRAFTO_INTEST_ISSUE: "463",
          DRAFTO_INTEST_PR: "591",
          DRAFTO_INTEST_SHA: "0d1fa723abc1fd299ca01abcd474c0de3b52ea33",
        },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^PRE-MERGE TEST BUILD — issue #463 \/ PR #591 \(0d1fa723abc1\)/);
    });
  });
}
