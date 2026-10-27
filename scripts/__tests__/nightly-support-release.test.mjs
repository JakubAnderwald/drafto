import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// nightly-support.sh ships merged support fixes itself (ADR-0042). The bug that
// motivated it (#658): the Claude session that fixed the issue also ran the
// Fastlane lanes — as background tasks — and ended its turn; `claude -p` exited
// and killed them seconds in. The fix never shipped, no "now live" was posted,
// and with no support issue open the next night exited early, so nothing ever
// retried. These tests pin the runner-owned release path and the shared
// build-root lib (scripts/lib/beta-build-root.sh) it uses with the factory.

const HERE = dirname(fileURLToPath(import.meta.url));
const NIGHTLY = resolve(HERE, "..", "nightly-support.sh");
const LIB = resolve(HERE, "..", "lib", "beta-build-root.sh");
const FACTORY = resolve(HERE, "..", "factory-agent.sh");
const nightly = readFileSync(NIGHTLY, "utf8");
const lib = readFileSync(LIB, "utf8");
// Code only — comments may name the very constructs a test forbids.
const stripComments = (src) =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const factory = readFileSync(FACTORY, "utf8");
// The Mac mini runs these under macOS's stock /bin/bash 3.2; CI has only a newer
// bash. Prefer the real thing when present.
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

// The prompt's whole statement: the read line, the body and the closing PROMPT.
function promptBlock(varName) {
  const start = nightly.indexOf(`IFS= read -r -d '' ${varName} <<PROMPT || true\n`);
  assert.ok(start !== -1, `${varName} heredoc not found`);
  const end = nightly.indexOf("\nPROMPT\n", start) + "\nPROMPT\n".length;
  return nightly.slice(start, end);
}
// Just the text Claude gets, as written in the script.
const heredoc = (varName) => promptBlock(varName).split("\n").slice(1, -2).join("\n");
const supportPrompt = heredoc("SUPPORT_PROMPT");
const dependabotPrompt = heredoc("DEPENDABOT_PROMPT");

// Runs the prompt's statement under BASH with every variable it expands
// stubbed as stub_<NAME>, and returns what the prompt variable ends up holding.
function buildPrompt(varName) {
  const block = promptBlock(varName);
  const names = new Set([...block.matchAll(/(?<!\\)\$\{?([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
  const stubs = [...names].map((n) => `${n}=stub_${n}`).join("\n");
  const script = `set -euo pipefail\n${stubs}\n${block}printf '%s' "$${varName}"\n`;
  return spawnSync(BASH, ["-c", script], { encoding: "utf8" });
}

function fnSource(src, name) {
  const m = src.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `could not find ${name}()`);
  return m[0];
}

describe("syntax", () => {
  for (const f of [NIGHTLY, LIB, FACTORY]) {
    it(`${f.split("/scripts/")[1]} passes bash -n`, () => {
      const r = spawnSync(BASH, ["-n", f], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  }

  it("keeps bash 3.2 compatible (no ${VAR,,}, declare -A, mapfile)", () => {
    for (const [name, src] of [
      ["nightly-support.sh", stripComments(nightly)],
      ["beta-build-root.sh", stripComments(lib)],
    ]) {
      assert.doesNotMatch(src, /\$\{[A-Za-z_]+,,\}/, `${name}: \${VAR,,} is bash 4+`);
      assert.doesNotMatch(src, /declare -A/, `${name}: associative arrays are bash 4+`);
      assert.doesNotMatch(src, /^\s*(mapfile|readarray)\b/m, `${name}: mapfile is bash 4+`);
    }
  });
});

describe("the Claude session no longer ships anything", () => {
  it("has no build / release step in the support prompt", () => {
    assert.doesNotMatch(supportPrompt, /fastlane\s+(android\s+|ios\s+|mac\s+)?beta/i);
    assert.doesNotMatch(supportPrompt, /release:beta/);
    assert.doesNotMatch(supportPrompt, /poll required CI checks/i, "the runner checks main CI");
    assert.match(supportPrompt, /STOP after the merge/);
    assert.match(supportPrompt, /Never ship an app/);
    assert.match(supportPrompt, /Never start a background task that must outlive this session/);
  });

  it("resolves the support worktree before telling the reporter it's working on it", () => {
    const resolveAt = nightly.indexOf('SUPPORT_WT=$(session_worktree_path "drafto-support-');
    assert.ok(resolveAt !== -1);
    assert.ok(resolveAt < nightly.indexOf("Working on it now (from the nightly agent)."));
  });

  it("puts the session in a fixed worktree and keeps it out of the fossil checkout", () => {
    assert.match(
      nightly,
      /SUPPORT_WT=\$\(session_worktree_path "drafto-support-\$\{ISSUE_NUMBER\}"\)/,
    );
    assert.match(
      nightly,
      /DEPENDABOT_WT=\$\(session_worktree_path "drafto-dependabot-\$\{PR_NUMBER\}"\)/,
    );
    assert.match(
      supportPrompt,
      /worktree add -b \$\{SUPPORT_BRANCH\} \$\{SUPPORT_WT\} origin\/main/,
    );
    assert.match(supportPrompt, /NEVER run pnpm install,\n\s+git checkout/);
    assert.match(dependabotPrompt, /NEVER run pnpm install,\n\s+git checkout/);
  });

  it("never builds a prompt through $(cat <<PROMPT)", () => {
    // Bash 3.2 pairs up the apostrophes in a heredoc inside $(…). Two of them
    // in the Dependabot prompt ran "to" from "Safe to merge" as a command, and
    // the nightly run died with exit 127 (#691). CI has no bash 3.2, so this
    // static check is what catches a regression there.
    assert.doesNotMatch(stripComments(nightly), /\$\(cat <<\s*PROMPT/);
  });

  for (const varName of ["SUPPORT_PROMPT", "DEPENDABOT_PROMPT"]) {
    it(`builds ${varName} in full under the real bash`, () => {
      const r = buildPrompt(varName);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, "");
      const lines = r.stdout.split("\n");
      assert.equal(lines.pop(), "", "ends with the heredoc's final newline");
      assert.equal(lines.length, heredoc(varName).split("\n").length, "no line lost");
    });
  }

  it("keeps the apostrophes, quotes and escaped backticks of the Dependabot prompt", () => {
    const { stdout } = buildPrompt("DEPENDABOT_PROMPT");
    assert.match(stdout, /Check if the package's major bump/);
    assert.match(stdout, /features\/APIs we don't use/);
    assert.match(stdout, /"Safe to merge" \/ "Merge with changes" \/ "Skip this version"/);
    assert.match(stdout, /poll `gh pr checks stub_PR_NUMBER` every 30 seconds/);
  });

  it("bounds every claude call with run-claude.mjs and waits for its background tasks", () => {
    assert.doesNotMatch(nightly, /^\s*(if ! )?claude -p/m, "no unbounded claude call");
    assert.match(
      nightly,
      /CLAUDE_CALL_TIMEOUT_SEC="\$SUPPORT_CLAUDE_TIMEOUT_SEC" \\\n\s+node "\$SCRIPT_DIR\/lib\/run-claude\.mjs" -p "\$SUPPORT_PROMPT"/,
    );
    assert.match(
      nightly,
      /CLAUDE_CALL_TIMEOUT_SEC="\$DEPENDABOT_CLAUDE_TIMEOUT_SEC" \\\n\s+node "\$SCRIPT_DIR\/lib\/run-claude\.mjs" -p "\$DEPENDABOT_PROMPT"/,
    );
    assert.match(nightly, /^export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0$/m);
    assert.match(nightly, /SUPPORT_CLAUDE_TIMEOUT_SEC="\$\{SUPPORT_CLAUDE_TIMEOUT_SEC:-7200\}"/);
    assert.match(
      nightly,
      /DEPENDABOT_CLAUDE_TIMEOUT_SEC="\$\{DEPENDABOT_CLAUDE_TIMEOUT_SEC:-3600\}"/,
    );
  });

  it("removes the session worktree once the issue is closed", () => {
    assert.match(nightly, /remove_session_worktree "\$SUPPORT_WT" "\$SUPPORT_BRANCH"/);
    const fn = fnSource(nightly, "remove_session_worktree");
    assert.match(fn, /grep -Fxq "worktree \$wt"/, "only a registered worktree");
    assert.match(fn, /worktree remove --force "\$match"/);
  });
});

describe("runner flow", () => {
  it("does not exit early while a merged fix still needs a beta", () => {
    assert.match(
      nightly,
      /if \[\[ "\$DEPENDABOT_COUNT" -eq 0 && "\$SUPPORT_COUNT" -eq 0 && "\$PENDING_COUNT" -eq 0 \]\]; then/,
    );
    assert.match(nightly, /PENDING_COUNT=-1/, "an unknown count must not read as zero");
  });

  it("iterates support issues with a C-style loop (BSD seq 0 -1 counts down)", () => {
    assert.doesNotMatch(stripComments(nightly), /seq 0/);
    assert.match(nightly, /for \(\(IDX=0; IDX<SUPPORT_COUNT; IDX\+\+\)\); do/);
  });

  it("dispatches through dispatch-release.mjs with per-lane --release-issues", () => {
    const fn = fnSource(nightly, "ship_support_betas");
    assert.match(fn, /dispatch-release\.mjs" dispatch --platforms "\$lane"/);
    assert.match(fn, /--release-issues "\$csv"/);
    assert.match(fn, /support-release\.mjs" main-ci "\$sha"/);
    assert.match(fn, /ensure_beta_build_root "\$lane" "\$sha"/);
    assert.match(fn, /claim_beta_build_root "\$lane" "\$pid"/);
    assert.match(fn, /support-release\.mjs" settle --pending-file/);
    // Beta only — nothing here can reach a production lane.
    assert.doesNotMatch(
      nightly,
      /release:prod|release:production|release:promote|fastlane \w+ (production|promote)/,
    );
  });

  it("can't trip the failure trap on an expected retry path", () => {
    assert.match(nightly, /^ship_support_betas \|\| log "WARNING: Phase 4 ended early/m);
  });
});

describe("factory-agent.sh uses the shared lib", () => {
  it("sources it and no longer defines the moved helpers", () => {
    assert.match(factory, /^source "\$SCRIPT_DIR\/lib\/beta-build-root\.sh"$/m);
    assert.match(nightly, /^source "\$SCRIPT_DIR\/lib\/beta-build-root\.sh"$/m);
    for (const fn of [
      "copy_worktree_env",
      "seed_worktree_node_modules",
      "run_pnpm_install",
      "ensure_beta_build_root",
      "claim_beta_build_root",
      "release_beta_build_root",
    ]) {
      assert.doesNotMatch(
        factory,
        new RegExp(`^${fn}\\(\\) \\{`, "m"),
        `${fn} must live in the lib`,
      );
      assert.match(lib, new RegExp(`^${fn}\\(\\) \\{`, "m"), `${fn} missing from the lib`);
    }
  });

  it("drops a root lock it still holds when a pre-merge lane did not start", () => {
    const fn = fnSource(factory, "intest_dispatch_betas");
    assert.match(fn, /\[\[ -n "\$\{mobile_root:-\}" \]\] && release_beta_build_root mobile/);
    assert.match(fn, /\[\[ -n "\$\{desktop_root:-\}" \]\] && release_beta_build_root desktop/);
  });
});

// ── Real-bash tests of the lib's root lock ──────────────────────────────────

function runLib(body, { env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "beta-root-lock-"));
  const script = [
    "set -euo pipefail",
    `LOG_FILE=${JSON.stringify(join(dir, "log"))}`,
    `REPO_ROOT=${JSON.stringify(join(dir, "not-a-repo"))}`,
    `SCRIPT_DIR=${JSON.stringify(join(dir, "not-a-repo", "scripts"))}`,
    "INSTALL_TIMEOUT_SEC=5",
    'log() { echo "[log] $*" >>"$LOG_FILE"; }',
    'logerr() { echo "[logerr] $*" >>"$LOG_FILE"; }',
    `mkdir -p "$REPO_ROOT"`,
    `source ${JSON.stringify(LIB)}`,
    body,
  ].join("\n");
  const r = spawnSync(BASH, ["-c", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DRAFTO_BETA_MOBILE_ROOT: join(dir, "beta-mobile"),
      DRAFTO_DESKTOP_BUILD_ROOT: join(dir, "beta-desktop"),
      DRAFTO_DESKTOP_FOSSIL_ROOT: join(dir, "fossil"),
      ...env,
    },
  });
  let logText = "";
  try {
    logText = readFileSync(join(dir, "log"), "utf8");
  } catch {
    logText = "";
  }
  rmSync(dir, { recursive: true, force: true });
  return { ...r, log: logText };
}

describe("beta-build-root.sh — root lock (real bash)", () => {
  it("defaults both roots to the build volume only when it is mounted", () => {
    const r = runLib('echo "$BETA_MOBILE_ROOT|$BETA_DESKTOP_ROOT"', {
      env: {
        DRAFTO_BETA_MOBILE_ROOT: "",
        DRAFTO_DESKTOP_BUILD_ROOT: "",
        DRAFTO_BUILDS_VOLUME_DIR: "/nonexistent-volume-for-test",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      "/Users/jakub/code/drafto-beta-mobile|/Users/jakub/code/drafto-beta-desktop",
    );
    const vol = mkdtempSync(join(tmpdir(), "builds-volume-"));
    try {
      const r2 = runLib('echo "$BETA_MOBILE_ROOT|$BETA_DESKTOP_ROOT"', {
        env: {
          DRAFTO_BETA_MOBILE_ROOT: "",
          DRAFTO_DESKTOP_BUILD_ROOT: "",
          DRAFTO_BUILDS_VOLUME_DIR: vol,
        },
      });
      // The volume's name is ASCII (ADR-0060), so the mobile root follows it too.
      assert.equal(r2.stdout.trim(), `${vol}/drafto-beta-mobile|${vol}/drafto-beta-desktop`);
    } finally {
      rmSync(vol, { recursive: true, force: true });
    }
  });

  it("treats a present but unwritable volume dir as not mounted", () => {
    // A stale, root-owned mount point left behind by an unclean eject.
    const vol = mkdtempSync(join(tmpdir(), "builds-volume-stale-"));
    try {
      spawnSync("chmod", ["555", vol]);
      const r = runLib('echo "$BETA_MOBILE_ROOT|$BETA_DESKTOP_ROOT"', {
        env: {
          DRAFTO_BETA_MOBILE_ROOT: "",
          DRAFTO_DESKTOP_BUILD_ROOT: "",
          DRAFTO_BUILDS_VOLUME_DIR: vol,
        },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        r.stdout.trim(),
        "/Users/jakub/code/drafto-beta-mobile|/Users/jakub/code/drafto-beta-desktop",
      );
    } finally {
      spawnSync("chmod", ["755", vol]);
      rmSync(vol, { recursive: true, force: true });
    }
  });

  it("refuses a non-ASCII mobile root before locking; desktop may use one", () => {
    // 2026-10-09: React Native 0.83's iOS pods (URI::File.build) failed on
    // /Volumes/Zewnętrzny — the #658 iOS beta never built there. The unique
    // test-owned dir keeps the non-ASCII byte in both roots' paths.
    const dir = mkdtempSync(join(tmpdir(), "Zewnętrzny-test-"));
    try {
      const r = runLib(
        `
if ensure_beta_build_root mobile deadbeef >/dev/null; then echo MOBILE-OK; else echo MOBILE-REFUSED; fi
[[ -e "$BETA_MOBILE_ROOT.lock" ]] && echo LOCKED || echo NO-LOCK
ensure_beta_build_root desktop deadbeef >/dev/null || true
grep -q 'non-ASCII' "$LOG_FILE" && echo LOGGED
[[ $(grep -c 'refusing mobile beta build root' "$LOG_FILE") -eq 1 ]] && echo ONLY-MOBILE`,
        {
          env: {
            DRAFTO_BETA_MOBILE_ROOT: join(dir, "beta-mobile"),
            DRAFTO_DESKTOP_BUILD_ROOT: join(dir, "beta-desktop"),
          },
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /MOBILE-REFUSED\nNO-LOCK\nLOGGED\nONLY-MOBILE/);
      assert.match(r.log, /React Native 0\.83's iOS pods reject non-ASCII paths/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes a free lock with the caller's pid, re-entrantly", () => {
    const r = runLib(`
_beta_root_lock mobile "$BETA_MOBILE_ROOT"
[[ "$(cat "$BETA_MOBILE_ROOT.lock")" == "$$" ]] && echo OWN
_beta_root_lock mobile "$BETA_MOBILE_ROOT" && echo REENTRANT
ls "$(dirname "$BETA_MOBILE_ROOT")" | grep -c '\\.tmp$' || true`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OWN\nREENTRANT\n0/);
  });

  it("refuses a root another live process holds, and reaps a dead holder's lock", () => {
    const r = runLib(`
sleep 30 & HOLDER=$!
echo "$HOLDER" > "$BETA_DESKTOP_ROOT.lock"
if _beta_root_lock desktop "$BETA_DESKTOP_ROOT"; then echo TOOK; else echo REFUSED; fi
kill "$HOLDER"; wait "$HOLDER" 2>/dev/null || true
if _beta_root_lock desktop "$BETA_DESKTOP_ROOT"; then echo REAPED; fi
[[ "$(cat "$BETA_DESKTOP_ROOT.lock")" == "$$" ]] && echo OWN`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REFUSED\nREAPED\nOWN/);
    assert.match(r.log, /beta build root .* is in use by pid \d+; refusing to reset it/);
  });

  it("reaps only the dead lock it judged, never one another caller took since", () => {
    // Two schedulers both read the same dead pid. The first reaps it and takes
    // the lock; the second's reap must then see a different pid and keep it.
    const r = runLib(`
sleep 30 & OTHER=$!
echo "$OTHER" > "$BETA_MOBILE_ROOT.lock"      # the other caller already took over
_beta_root_reap "$BETA_MOBILE_ROOT.lock" 999999
[[ "$(cat "$BETA_MOBILE_ROOT.lock")" == "$OTHER" ]] && echo KEPT
echo 999999 > "$BETA_MOBILE_ROOT.lock"
_beta_root_reap "$BETA_MOBILE_ROOT.lock" 999999
[[ -e "$BETA_MOBILE_ROOT.lock" ]] || echo REAPED
[[ -e "$BETA_MOBILE_ROOT.lock.reap" ]] || echo GUARD-GONE
kill "$OTHER"`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /KEPT\nREAPED\nGUARD-GONE/);
  });

  it("re-derives the default roots when the volume appears later", () => {
    const vol = mkdtempSync(join(tmpdir(), "builds-volume-late-"));
    rmSync(vol, { recursive: true, force: true });
    try {
      const r = runLib(
        `echo "$BETA_MOBILE_ROOT|$BETA_DESKTOP_ROOT"; mkdir -p "$BETA_BUILDS_VOLUME_DIR"; resolve_beta_build_roots; echo "$BETA_MOBILE_ROOT|$BETA_DESKTOP_ROOT"`,
        {
          env: {
            DRAFTO_BETA_MOBILE_ROOT: "",
            DRAFTO_DESKTOP_BUILD_ROOT: "",
            DRAFTO_BUILDS_VOLUME_DIR: vol,
          },
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.trim().split("\n"), [
        "/Users/jakub/code/drafto-beta-mobile|/Users/jakub/code/drafto-beta-desktop",
        `${vol}/drafto-beta-mobile|${vol}/drafto-beta-desktop`,
      ]);
    } finally {
      rmSync(vol, { recursive: true, force: true });
    }
  });

  it("release drops our own or a dead holder's lock, never a live lane's", () => {
    const r = runLib(`
_beta_root_lock mobile "$BETA_MOBILE_ROOT"
release_beta_build_root mobile
[[ -e "$BETA_MOBILE_ROOT.lock" ]] || echo OURS-DROPPED
sleep 30 & LANE=$!
claim_beta_build_root mobile "$LANE"
release_beta_build_root mobile
[[ "$(cat "$BETA_MOBILE_ROOT.lock")" == "$LANE" ]] && echo LIVE-KEPT
kill "$LANE"; wait "$LANE" 2>/dev/null || true
release_beta_build_root mobile
[[ -e "$BETA_MOBILE_ROOT.lock" ]] || echo DEAD-DROPPED`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OURS-DROPPED\nLIVE-KEPT\nDEAD-DROPPED/);
  });

  it("ensure_beta_build_root locks before touching the root and unlocks when it fails", () => {
    // REPO_ROOT is not a git repo, so creating the worktree fails after the lock.
    const r = runLib(`
if out=$(ensure_beta_build_root mobile deadbeef); then echo "OK:$out"; else echo FAILED; fi
[[ -e "$BETA_MOBILE_ROOT.lock" ]] && echo LEFT-LOCKED || echo UNLOCKED`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FAILED\nUNLOCKED/);
    assert.match(r.log, /could not create beta build root/);
  });

  // Real git: an origin with two commits and a clone that has only the first.
  // Runs ensure_beta_build_root for the desktop root at `sha` (default: the
  // commit the clone lacks) and returns the result plus what the run logged.
  function withRealGit(fn) {
    const dir = mkdtempSync(join(tmpdir(), "beta-root-fetch-"));
    try {
      const git = (cwd, ...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
      const id = ["-c", "user.email=t@t", "-c", "user.name=t"];
      const origin = join(dir, "origin");
      mkdirSync(origin);
      git(origin, "init", "-q", "-b", "main");
      git(origin, ...id, "commit", "-q", "--allow-empty", "-m", "one");
      const repo = join(dir, "repo");
      assert.equal(spawnSync("git", ["clone", "-q", origin, repo]).status, 0);
      const localSha = git(repo, "rev-parse", "HEAD").stdout.trim();
      git(origin, ...id, "commit", "-q", "--allow-empty", "-m", "two");
      const remoteSha = git(origin, "rev-parse", "HEAD").stdout.trim();
      const root = join(dir, "beta-desktop");
      const logFile = join(dir, "log");
      const ensure = (sha, { env = {}, timeout } = {}) => {
        const r = spawnSync(
          BASH,
          [
            "-c",
            [
              "set -uo pipefail",
              `LOG_FILE=${JSON.stringify(logFile)}`,
              `REPO_ROOT=${JSON.stringify(repo)}`,
              // The real scripts dir: the fetch runs under lib/run-with-timeout.mjs.
              `SCRIPT_DIR=${JSON.stringify(resolve(HERE, ".."))}`,
              "INSTALL_TIMEOUT_SEC=5",
              `log() { :; }; logerr() { echo "$*" >> "$LOG_FILE"; }`,
              `source ${JSON.stringify(LIB)}`,
              `ensure_beta_build_root desktop ${sha}`,
            ].join("\n"),
          ],
          {
            encoding: "utf8",
            timeout,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              DRAFTO_DESKTOP_BUILD_ROOT: root,
              DRAFTO_BETA_MOBILE_ROOT: join(dir, "beta-mobile"),
              DRAFTO_DESKTOP_FOSSIL_ROOT: join(dir, "fossil"),
              ...env,
            },
          },
        );
        const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
        return { ...r, log };
      };
      return fn({ git, repo, root, localSha, remoteSha, ensure });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("ensure_beta_build_root fetches before creating a root at a sha not yet local", () => {
    // The nightly passes origin/main's head straight from the GitHub API.
    withRealGit(({ git, repo, root, remoteSha, ensure }) => {
      assert.notEqual(
        git(repo, "cat-file", "-e", remoteSha).status,
        0,
        "precondition: not local yet",
      );
      const r = ensure(remoteSha);
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.equal(r.stdout.trim(), root);
      assert.equal(git(root, "rev-parse", "HEAD").stdout.trim(), remoteSha);
    });
  });

  it("ensure_beta_build_root skips the network when the sha is already local", () => {
    // An unreachable origin proves no fetch ran: it would fail and warn.
    withRealGit(({ git, repo, root, localSha, ensure }) => {
      git(repo, "remote", "set-url", "origin", "/nonexistent/drafto-origin");
      const r = ensure(localSha);
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.equal(git(root, "rev-parse", "HEAD").stdout.trim(), localSha);
      assert.doesNotMatch(r.log, /fetch failed/);
    });
  });

  it("ensure_beta_build_root bounds a stalled fetch and releases the lock", () => {
    // A remote that never answers must not hold the build-root lock forever.
    withRealGit(({ git, repo, root, remoteSha, ensure }) => {
      git(repo, "remote", "set-url", "origin", "ssh://stalled.invalid/drafto.git");
      const started = Date.now();
      const r = ensure(remoteSha, {
        env: {
          DRAFTO_BETA_FETCH_TIMEOUT_SEC: "1",
          GIT_SSH_COMMAND: 'sh -c "sleep 20" --',
        },
        timeout: 15000,
      });
      assert.ok(Date.now() - started < 12000, "the fetch was not cut off by its cap");
      assert.notEqual(r.status, 0, "the sha is still missing, so creating the root fails");
      assert.match(r.log, /fetch failed or timed out/);
      assert.equal(existsSync(`${root}.lock`), false, "lock left behind");
    });
  });

  it("ensure_beta_build_root refuses a root another live process holds", () => {
    const r = runLib(`
sleep 30 & HOLDER=$!
echo "$HOLDER" > "$BETA_MOBILE_ROOT.lock"
if ensure_beta_build_root mobile deadbeef >/dev/null; then echo OK; else echo REFUSED; fi
[[ "$(cat "$BETA_MOBILE_ROOT.lock")" == "$HOLDER" ]] && echo UNTOUCHED
kill "$HOLDER"`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REFUSED\nUNTOUCHED/);
  });
});

// ── remove_session_worktree against a real git repo ─────────────────────────

describe("remove_session_worktree (real git)", () => {
  it("removes only a registered worktree, with its fix/support branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightly-wt-"));
    try {
      const repo = join(dir, "repo");
      mkdirSync(repo);
      const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
      git("init", "-q", "-b", "main");
      git(
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
      // Pushed: the commit is on a remote-tracking ref.
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      const wt = join(dir, "drafto-support-658");
      assert.equal(git("worktree", "add", "-q", "-b", "fix/support-658", wt).status, 0);
      // Untracked tool output (next dev's AGENTS.md) doesn't count as work.
      writeFileSync(join(wt, "AGENTS.md"), "generated\n");
      const stray = join(dir, "drafto-support-999");
      mkdirSync(stray);
      // An unpushed fix: kept, with its branch.
      const unpushed = join(dir, "drafto-support-659");
      assert.equal(git("worktree", "add", "-q", "-b", "fix/support-659", unpushed).status, 0);
      spawnSync(
        "git",
        [
          "-C",
          unpushed,
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "wip",
        ],
        { encoding: "utf8" },
      );
      const fn = [
        fnSource(nightly, "session_worktree_has_local_work"),
        fnSource(nightly, "remove_session_worktree"),
      ].join("\n");
      const r = spawnSync(
        BASH,
        [
          "-c",
          [
            `REPO_ROOT=${JSON.stringify(repo)}`,
            `LOG_FILE=${JSON.stringify(join(dir, "log"))}`,
            'log() { echo "$*"; }',
            fn,
            `remove_session_worktree ${JSON.stringify(stray)}`,
            `remove_session_worktree ${JSON.stringify(wt)} fix/support-658`,
            `remove_session_worktree ${JSON.stringify(unpushed)} fix/support-659`,
          ].join("\n"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(wt), "registered worktree removed");
      assert.ok(existsSync(stray), "an unregistered directory is never touched");
      assert.equal(git("branch", "--list", "fix/support-658").stdout.trim(), "");
      assert.ok(existsSync(unpushed), "a worktree with unpushed commits is kept");
      assert.notEqual(git("branch", "--list", "fix/support-659").stdout.trim(), "");
      assert.match(
        r.stdout,
        /Keeping worktree .*drafto-support-659: it holds uncommitted changes or unpushed commits/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── session worktree parent, reuse and sweep against a real git repo ────────

describe("session worktrees (real git)", () => {
  function setupRepo() {
    // git records worktree paths symlink-resolved (/var → /private/var on macOS).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nightly-sweep-")));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lock\n");
    git("add", "pnpm-lock.yaml");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
    // The sweep only removes work that is on a remote-tracking ref.
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    return { dir, repo, git };
  }
  // gh stubbed by item: dependabot PRs 746/748 CLOSED, 747 MERGED, 754 OPEN;
  // support issues 700/702 CLOSED, 701 OPEN; anything else unreadable (empty).
  const GH_STUB = `gh() {
  case "$1 $2 $3" in
    "pr view 746"|"pr view 748") echo CLOSED ;; "pr view 747") echo MERGED ;; "pr view 754") echo OPEN ;;
    "issue view 700"|"issue view 702") echo CLOSED ;; "issue view 701") echo OPEN ;;
    *) return 1 ;;
  esac
}`;
  function runFns(repo, dir, body, extra = []) {
    return spawnSync(
      BASH,
      [
        "-c",
        [
          "set -euo pipefail",
          `REPO_ROOT=${JSON.stringify(repo)}`,
          `LOG_FILE=${JSON.stringify(join(dir, "log"))}`,
          'log() { echo "$*"; }',
          ...extra,
          fnSource(nightly, "session_worktree_has_local_work"),
          fnSource(nightly, "remove_session_worktree"),
          fnSource(nightly, "registered_worktree_paths"),
          fnSource(nightly, "session_worktree_path"),
          fnSource(nightly, "sweep_session_worktrees"),
          body,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
  }

  it("defaults the parent to the build volume's worktrees/ when mounted, else ~/code", () => {
    const block = nightly.match(
      /if \[\[ -z "\$\{SUPPORT_WORKTREE_PARENT:-\}" \]\]; then[\s\S]*?\nfi\n/,
    );
    assert.ok(block, "parent resolution block not found");
    const vol = mkdtempSync(join(tmpdir(), "builds-volume-wt-"));
    try {
      const resolveWith = (volDir, override = "") =>
        spawnSync(
          BASH,
          [
            "-c",
            `BETA_BUILDS_VOLUME_DIR=${JSON.stringify(volDir)}\nHOME=/home/x\nSUPPORT_WORKTREE_PARENT=${JSON.stringify(override)}\n${fnSource(lib, "build_volume_mounted")}\n${block[0]}echo "$SUPPORT_WORKTREE_PARENT"`,
          ],
          { encoding: "utf8" },
        ).stdout.trim();
      assert.equal(resolveWith(vol), `${vol}/worktrees`);
      assert.equal(resolveWith("/nonexistent-volume-for-test"), "/home/x/code");
      assert.equal(resolveWith(vol, "/custom"), "/custom", "an explicit override wins");
    } finally {
      rmSync(vol, { recursive: true, force: true });
    }
    // Resolved only after the lib that defines BETA_BUILDS_VOLUME_DIR is sourced.
    assert.ok(
      nightly.indexOf('source "$SCRIPT_DIR/lib/beta-build-root.sh"') < nightly.indexOf(block[0]),
    );
  });

  it("reuses a registered worktree from another parent, else a fresh path", () => {
    const { dir, repo, git } = setupRepo();
    try {
      const old = join(dir, "old-parent", "drafto-dependabot-754");
      assert.equal(git("worktree", "add", "-q", "-b", "dep-754", old).status, 0);
      const r = runFns(
        repo,
        dir,
        [
          "session_worktree_path drafto-dependabot-754",
          "session_worktree_path drafto-dependabot-760",
          "session_worktree_path drafto-dependabot-75",
        ].join("\n"),
        [`SUPPORT_WORKTREE_PARENT=${JSON.stringify(join(dir, "new-parent"))}`],
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.trim().split("\n"), [
        old,
        join(dir, "new-parent", "drafto-dependabot-760"),
        join(dir, "new-parent", "drafto-dependabot-75"),
      ]);

      // Registered, but its volume is gone: the path comes back with exit 1, so
      // the caller skips the item instead of colliding on the checked-out branch.
      rmSync(old, { recursive: true, force: true });
      const gone = runFns(
        repo,
        dir,
        'if p=$(session_worktree_path drafto-dependabot-754); then echo "OK $p"; else echo "GONE $p"; fi',
        [`SUPPORT_WORKTREE_PARENT=${JSON.stringify(join(dir, "new-parent"))}`],
      );
      assert.equal(gone.status, 0, gone.stderr);
      assert.equal(gone.stdout.trim(), `GONE ${old}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps finished items' worktrees in any parent and keeps open or unreadable ones", () => {
    const { dir, repo, git } = setupRepo();
    try {
      const wts = {
        closedPr: join(dir, "a", "drafto-dependabot-746"),
        mergedPr: join(dir, "b", "drafto-dependabot-747"),
        openPr: join(dir, "a", "drafto-dependabot-754"),
        unreadablePr: join(dir, "a", "drafto-dependabot-999"),
        closedIssue: join(dir, "b", "drafto-support-700"),
        openIssue: join(dir, "b", "drafto-support-701"),
        other: join(dir, "a", "drafto-factory"),
        dirtyClosedPr: join(dir, "b", "drafto-dependabot-748"),
        unpushedClosedIssue: join(dir, "b", "drafto-support-702"),
      };
      const branch = {
        closedIssue: "fix/support-700",
        openIssue: "fix/support-701",
        unpushedClosedIssue: "fix/support-702",
      };
      for (const [k, p] of Object.entries(wts)) {
        assert.equal(git("worktree", "add", "-q", "-b", branch[k] ?? `b-${k}`, p).status, 0);
      }
      // Local work the sweep must never destroy, whatever the item's state.
      writeFileSync(join(wts.dirtyClosedPr, "pnpm-lock.yaml"), "uncommitted\n");
      // Untracked tool output alone doesn't keep a finished item's worktree.
      writeFileSync(join(wts.closedPr, "AGENTS.md"), "generated\n");
      const wtGit = (p, ...a) => spawnSync("git", ["-C", p, ...a], { encoding: "utf8" });
      wtGit(
        wts.unpushedClosedIssue,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "fix",
      );
      // A registered worktree whose directory is gone (volume not mounted).
      const goneWt = join(dir, "c", "drafto-dependabot-749");
      assert.equal(git("worktree", "add", "-q", "-b", "b-gone", goneWt).status, 0);
      rmSync(goneWt, { recursive: true, force: true });
      const r = runFns(repo, dir, "sweep_session_worktrees", [GH_STUB]);
      assert.equal(r.status, 0, r.stderr);
      for (const k of ["closedPr", "mergedPr", "closedIssue"]) {
        assert.ok(!existsSync(wts[k]), `${k} worktree swept`);
      }
      for (const k of [
        "openPr",
        "unreadablePr",
        "openIssue",
        "other",
        "dirtyClosedPr",
        "unpushedClosedIssue",
      ]) {
        assert.ok(existsSync(wts[k]), `${k} worktree kept`);
      }
      assert.match(
        git("worktree", "list").stdout,
        /drafto-dependabot-749/,
        "a gone worktree stays registered",
      );
      assert.match(r.stdout, /Keeping worktree .*drafto-dependabot-748: it holds uncommitted/);
      assert.match(r.stdout, /Keeping worktree .*drafto-support-702/);
      assert.equal(git("branch", "--list", "fix/support-700").stdout.trim(), "");
      assert.notEqual(git("branch", "--list", "fix/support-701").stdout.trim(), "");
      assert.match(r.stdout, /Sweeping .*drafto-dependabot-746: #746 is CLOSED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the sweep before the no-items exit and Phase 2, and never prunes", () => {
    const code = stripComments(nightly);
    const sweepAt = code.indexOf("\nsweep_session_worktrees\n");
    assert.ok(sweepAt !== -1, "sweep must be called");
    // A quiet night is exactly when the queue no longer names finished items.
    assert.ok(
      sweepAt < code.indexOf('log "No items to process."'),
      "sweep must precede the early exit",
    );
    assert.ok(
      sweepAt < code.indexOf("for PR_NUMBER in"),
      "sweep must run before the Dependabot loop",
    );
    assert.doesNotMatch(code, /worktree prune/);
  });
});

// ── ship_support_betas (Phase 4) with every external call stubbed ───────────

const SHA = "a".repeat(40);
function pendingJson({ mobile = true, desktop = false } = {}) {
  return JSON.stringify({
    sha: SHA,
    issues: [
      ...(mobile
        ? [{ number: 658, closedAt: "2026-10-05T22:25:31Z", platforms: ["android", "ios"] }]
        : []),
      ...(desktop ? [{ number: 661, closedAt: "2026-10-05T10:00:00Z", platforms: ["macos"] }] : []),
    ],
    lanes: { mobile, desktop },
    laneIssues: { mobile: mobile ? "658" : "", desktop: desktop ? "661" : "" },
  });
}

// Runs the real kill_support_lane + ship_support_betas against stubs for node
// (support-release.mjs / dispatch-release.mjs) and the lib's root functions.
// LANE_<lane> picks the fake lane's behaviour: exit:<code> | die | skip.
function runPhase4({ pending, mainCiRc = 0, lanes = {}, ensureFail = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "nightly-phase4-"));
  const vol = join(dir, "volume");
  mkdirSync(vol);
  writeFileSync(join(dir, "pending.json"), pending);
  const harness = `
set -uo pipefail
DIR=${JSON.stringify(dir)}
LOG_FILE="$DIR/nightly.log"
RELEASE_LOG_DIR="$DIR/release"; mkdir -p "$RELEASE_LOG_DIR"
SCRIPT_DIR=/fake/scripts
BETA_BUILDS_VOLUME_DIR=${JSON.stringify(vol)}
BETA_MOBILE_ROOT="$DIR/beta-mobile"; BETA_DESKTOP_ROOT="$DIR/beta-desktop"
SUPPORT_MAIN_CI_WAIT_MIN=1 SUPPORT_LANE_POLL_SEC=1 SUPPORT_LANE_STALE_MIN=120
SUPPORT_LANE_MAX_MIN=180 SUPPORT_LANE_KILL_GRACE_SEC=1
unset DRAFTO_BETA_MOBILE_ROOT DRAFTO_DESKTOP_BUILD_ROOT
LANE_mobile=${JSON.stringify(lanes.mobile ?? "exit:0")}
LANE_desktop=${JSON.stringify(lanes.desktop ?? "exit:0")}
ENSURE_FAIL=${JSON.stringify(ensureFail.join(" "))}
log() { echo "[log] $*" >>"$LOG_FILE"; }
logerr() { echo "[logerr] $*" >>"$LOG_FILE"; }
${fnSource(lib, "build_volume_mounted")}
ensure_beta_build_root() {
  echo "ensure $1 $2" >>"$DIR/calls"
  [[ " $ENSURE_FAIL " == *" $1 "* ]] && return 1
  echo "$DIR/root-$1"
}
claim_beta_build_root() { echo "claim $1 $2" >>"$DIR/calls"; }
release_beta_build_root() { echo "release $1" >>"$DIR/calls"; }
node() {
  case "$1 \${2:-}" in
    *support-release.mjs\\ pending) echo "pending-args \${*:3}" >>"$DIR/calls"; cat "$DIR/pending.json" ;;
    *support-release.mjs\\ main-ci) echo "main-ci $3" >>"$DIR/calls"; return ${mainCiRc} ;;
    *support-release.mjs\\ settle) shift 2; echo "settle $*" >>"$DIR/calls"
      echo '{"settled":[{"number":658,"platform":"android","result":"ok","lane":"mobile","laneResult":"0","failures":0}]}' ;;
    *dispatch-release.mjs\\ dispatch)
      echo "dispatch $*" >>"$DIR/calls"
      local lane="" logdir="" key="" a
      shift 2
      while [[ $# -gt 0 ]]; do
        case "$1" in --platforms) lane="$2"; shift 2 ;; --log-dir) logdir="$2"; shift 2 ;; --log-key) key="$2"; shift 2 ;; *) shift ;; esac
      done
      local mode_var="LANE_$lane"; local mode="\${!mode_var}"
      local logp="$logdir/beta-lane-$lane-$key.log"
      if [[ "$mode" == skip ]]; then
        echo '{"dispatched":[],"failed":[],"skipped":[{"id":"'"$lane"'","reason":"React 19.2.6 is not 19.1.x"}]}'
        return 0
      fi
      echo "building" >"$logp"
      if [[ "$mode" == die ]]; then
        sh -c 'sleep 0.2' >/dev/null 2>&1 &
      else
        sh -c "sleep 0.5; echo \${mode#exit:} > '$logp.exit'" >/dev/null 2>&1 &
      fi
      echo '{"dispatched":[{"id":"'"$lane"'","pid":'"$!"',"logPath":"'"$logp"'","exitPath":"'"$logp.exit"'"}],"failed":[],"skipped":[]}'
      ;;
    *) echo "unexpected node $*" >>"$DIR/calls"; return 99 ;;
  esac
}
${fnSource(lib, "resolve_beta_build_roots")}
${fnSource(nightly, "kill_support_lane")}
${fnSource(nightly, "ship_support_betas")}
ship_support_betas; echo "rc=$?"
`;
  const r = spawnSync(BASH, ["-c", harness], { encoding: "utf8", timeout: 30_000 });
  const read = (f) => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return "";
    }
  };
  const out = { ...r, calls: read("calls"), log: read("nightly.log") };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

describe("ship_support_betas (stubbed, real bash)", () => {
  it("does nothing when no merged fix is pending", () => {
    const r = runPhase4({
      pending: JSON.stringify({ sha: null, issues: [], lanes: {}, laneIssues: {} }),
    });
    assert.match(r.stdout, /rc=0/);
    assert.match(r.log, /no merged support fix is waiting for a beta build/);
    assert.doesNotMatch(r.calls, /main-ci|ensure|dispatch|settle/);
  });

  it("does not ship — or spend an attempt — while main CI is red", () => {
    const r = runPhase4({ pending: pendingJson(), mainCiRc: 1 });
    assert.match(r.stdout, /rc=0/);
    assert.match(r.log, /main CI failed at aaaaaaaaaaaa; not shipping it — retry next night/);
    assert.doesNotMatch(r.calls, /ensure|dispatch|settle/);
  });

  it("waits out a pending main CI as a retry, not a failure", () => {
    const r = runPhase4({ pending: pendingJson(), mainCiRc: 2 });
    assert.match(r.log, /main CI still not green at aaaaaaaaaaaa after 1 min; retry next night/);
    assert.doesNotMatch(r.calls, /settle/);
  });

  it("never reports a main-ci tool error as a CI failure", () => {
    const r = runPhase4({ pending: pendingJson(), mainCiRc: 3 });
    assert.match(r.log, /could not check main CI at aaaaaaaaaaaa \(rc=3/);
    assert.doesNotMatch(r.log, /main CI failed/);
  });

  it("asks pending to flag expired fixes and logs them and per-issue lookup errors", () => {
    const r = runPhase4({
      pending: JSON.stringify({
        sha: null,
        issues: [],
        lanes: {},
        laneIssues: {},
        expired: [{ number: 600, platforms: ["ios"], flagged: true }],
        errors: [{ number: 601, error: "HTTP 406" }],
      }),
    });
    assert.match(r.calls, /pending-args --flag-expired/);
    assert.match(
      r.log,
      /#600 ios: left the release window unshipped — labelled needs-manual-intervention/,
    );
    assert.match(r.log, /#601: skipped tonight, GitHub lookup failed \(HTTP 406\)/);
  });

  it("dispatches, claims the root, waits for the exit code and settles it", () => {
    const r = runPhase4({ pending: pendingJson(), lanes: { mobile: "exit:0" } });
    assert.match(r.stdout, /rc=0/, r.stderr);
    assert.match(r.calls, new RegExp(`main-ci ${SHA}`));
    assert.match(r.calls, new RegExp(`ensure mobile ${SHA}`));
    assert.match(r.calls, /dispatch .*--platforms mobile .*--release-issues 658/);
    assert.match(r.calls, /claim mobile \d+/);
    assert.match(r.calls, /release mobile/);
    assert.match(
      r.calls,
      /settle --pending-file \S+pending-support-aaaaaaaaaaaa-\S+\.json --lanes mobile=0 --logs mobile=\S+beta-lane-mobile-support-aaaaaaaaaaaa-/,
    );
    assert.match(r.log, /the mobile lane exited 0/);
    assert.match(r.log, /Phase 4: #658 android: shipped/);
  });

  it("passes a failing lane's exit code through to settle", () => {
    const r = runPhase4({ pending: pendingJson(), lanes: { mobile: "exit:3" } });
    assert.match(r.calls, /settle .*--lanes mobile=3 /);
  });

  it("treats a lane that vanished without an exit code as died", () => {
    const r = runPhase4({ pending: pendingJson(), lanes: { mobile: "die" } });
    assert.match(r.calls, /settle .*--lanes mobile=died /);
    assert.match(r.log, /died without recording an exit code/);
  });

  it("skips a lane whose root is busy without dispatching or settling it", () => {
    const r = runPhase4({ pending: pendingJson(), ensureFail: ["mobile"] });
    assert.match(r.log, /mobile build root unavailable .* retry next night/);
    assert.doesNotMatch(r.calls, /dispatch|settle/);
  });

  it("ships each lane with its own issues; a fossil-refused lane is released, not settled", () => {
    const r = runPhase4({
      pending: pendingJson({ mobile: true, desktop: true }),
      lanes: { mobile: "exit:0", desktop: "skip" },
    });
    assert.match(r.calls, /dispatch .*--platforms mobile .*--release-issues 658/);
    assert.match(r.calls, /dispatch .*--platforms desktop .*--release-issues 661/);
    assert.match(r.calls, /release desktop/);
    assert.match(
      r.log,
      /desktop beta lane did not start \(React 19\.2\.6 is not 19\.1\.x\); retry next night/,
    );
    assert.match(r.calls, /settle .*--lanes mobile=0 --logs mobile=/);
    assert.doesNotMatch(r.calls, /--lanes [^ ]*desktop=/);
  });
});
